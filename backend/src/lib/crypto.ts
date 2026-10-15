import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { serverEnv, type ServerEnv } from "./env";

// AES-256-GCM for secrets at rest (WhatsApp tokens, app secrets). Stored as v1:<iv>:<tag>:<ciphertext>.
// `context` is REQUIRED GCM additional authenticated data: it is not stored, so a ciphertext copied to
// another row, tenant or column fails to decrypt. Only connectionSecretContext() can make one, so
// callers cannot hand-write it. Create the row id BEFORE encrypting, then pass the same context on
// every decrypt. Errors never include secrets or context.

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

/** The additional authenticated data of a secret. Built only by the context functions in this file. */
export type SecretContext = string & { readonly __brand: "SecretContext" };

type KeySource = Pick<ServerEnv, "ENCRYPTION_KEY">;

function keyFrom(env: KeySource | undefined): Buffer {
  const encoded = (env ?? serverEnv()).ENCRYPTION_KEY;
  if (encoded === undefined) throw new CryptoError("ENCRYPTION_KEY is not set");
  return Buffer.from(encoded, "base64");
}

// The type already demands a SecretContext; this guards JavaScript callers and casts. GCM treats an
// empty AAD as no AAD, so an empty context would silently turn the binding off.
function aadFrom(context: unknown): Buffer {
  if (typeof context !== "string") throw new CryptoError("context is required");
  if (context === "") throw new CryptoError("context must not be empty");
  return Buffer.from(context, "utf8");
}

// Node's base64url decoder is lenient: several strings decode to the same bytes (unused trailing
// bits, a dangling character). Accept a part only if it re-encodes to exactly itself, so every stored
// value has one spelling and a rewritten one is rejected. The alphabet check also rules out "=".
function decodeCanonical(part: string): Buffer | null {
  if (!BASE64URL.test(part)) return null;
  const bytes = Buffer.from(part, "base64url");
  return bytes.toString("base64url") === part ? bytes : null;
}

export function encryptSecret(
  plaintext: string,
  context: SecretContext,
  env?: KeySource,
): string {
  const aad = aadFrom(context);
  const key = keyFrom(env);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return [
      VERSION,
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(":");
  } catch {
    throw new CryptoError("could not encrypt secret");
  }
}

export function decryptSecret(
  stored: string,
  context: SecretContext,
  env?: KeySource,
): string {
  const aad = aadFrom(context);
  const key = keyFrom(env);

  const parts = typeof stored === "string" ? stored.split(":") : [];
  const [version, ivPart, tagPart, dataPart] = parts;
  if (parts.length !== 4 || version !== VERSION) {
    throw new CryptoError("stored secret is malformed");
  }
  const iv = decodeCanonical(ivPart);
  const tag = decodeCanonical(tagPart);
  const data = decodeCanonical(dataPart);
  if (!iv || !tag || !data || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoError("stored secret is malformed");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    // Tampered value, wrong key and wrong context are deliberately indistinguishable.
    throw new CryptoError("could not decrypt stored secret");
  }
}

// Columns of whatsapp_connections that hold encrypted secrets.
export type ConnectionSecretColumn = "token_enc" | "app_secret_enc";

const SECRET_COLUMNS: readonly string[] = ["token_enc", "app_secret_enc"];

// The one place that builds the context for a connection secret, so encrypt and decrypt cannot
// drift. Use only immutable values: the row id and tenant id, never status, phone or other editable
// fields. A secret of another kind (for example calendar tokens) gets its own builder here that
// also returns a SecretContext.
export function connectionSecretContext(parts: {
  column: ConnectionSecretColumn;
  tenantId: string;
  connectionId: string;
}): SecretContext {
  const { column, tenantId, connectionId } = parts;
  if (!SECRET_COLUMNS.includes(column)) {
    throw new CryptoError("unsupported secret column");
  }
  // ":" separates the parts, so allowing it inside one would make two contexts collide.
  for (const id of [tenantId, connectionId]) {
    if (id === "" || id.includes(":")) throw new CryptoError("invalid context part");
  }
  return `whatsapp_connections:${column}:${tenantId}:${connectionId}` as SecretContext;
}

// whatsapp_webhook_tokens.token_enc: one token per business, so the business id identifies the row.
export function webhookTokenSecretContext(tenantId: string): SecretContext {
  if (tenantId === "" || tenantId.includes(":")) throw new CryptoError("invalid context part");
  return `whatsapp_webhook_tokens:token_enc:${tenantId}` as SecretContext;
}

// webhook_endpoints.secret_enc: one endpoint per business, so the business id identifies the row.
export function webhookEndpointSecretContext(tenantId: string): SecretContext {
  if (tenantId === "" || tenantId.includes(":")) throw new CryptoError("invalid context part");
  return `webhook_endpoints:secret_enc:${tenantId}` as SecretContext;
}

// google_calendar_connections.refresh_token_enc. A resource has at most one connection, and its id
// never changes, so the resource id identifies the row (and is known before the row exists).
export function calendarSecretContext(parts: { tenantId: string; resourceId: string }): SecretContext {
  const { tenantId, resourceId } = parts;
  for (const id of [tenantId, resourceId]) {
    if (id === "" || id.includes(":")) throw new CryptoError("invalid context part");
  }
  return `google_calendar_connections:refresh_token_enc:${tenantId}:${resourceId}` as SecretContext;
}

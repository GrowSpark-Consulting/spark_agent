import { z } from "zod";
import { connectionSecretContext, decryptSecret } from "../lib/crypto";
import type { ServerEnv } from "../lib/env";
import { mediaExtension, messageMediaPath } from "../lib/storage";
import { TimeoutError, withTimeout } from "../lib/timeout";

// Saving a customer's photo or document (Day 7, PR F). The webhook stored only Meta's media id and type on the message; this downloads the file
// and keeps it in the private bucket message-media, at <tenant_id>/<conversation_id>/<message_id>.<ext> (lib/storage.ts). Two Graph calls, both
// UNVERIFIED against Meta (they follow its documentation): GET /{media-id} gives a short-lived address, and the address is fetched with the same token.
//
//   * The business comes from the stored message row (every lookup filters by it), never from the webhook; the token is the one of this
//     business's connection for the chat's channel, decrypted for the call and never kept, logged or returned.
//   * Only images (jpeg, png, webp) and documents (pdf, text, Office), 5 MB and 20 MB, by Meta's own type, by the declared size and by the bytes
//     actually read, and the first bytes of an image or a pdf must match their type. Anything else is not stored and the message says why.
//   * Running twice changes nothing: a message that has its file (or a final reason) is left alone, and the upload is an overwrite of a fixed path.
//   * It sends nothing to the customer. A failure that may pass is a MediaRetryError (Inngest retries); one that will not is recorded on the message.
//   * Errors carry fixed words only: never Meta's text, an address, an id or a token.

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
const GRAPH_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 15_000;

const ALLOWED: Record<string, readonly string[]> = {
  image: ["image/jpeg", "image/png", "image/webp"],
  document: [
    "application/pdf",
    "text/plain",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
};
const MAX_BYTES: Record<string, number> = { image: IMAGE_MAX_BYTES, document: DOCUMENT_MAX_BYTES };

/** The message as the download needs it. `media` is the jsonb the webhook stored ({ id, mime }) plus whatever this job has added. */
export type MediaMessage = { kind: string; channelId: string; media: Record<string, unknown> | null };

export interface DownloadDeps {
  /** The customer's inbound message of this chat and business, or null. Must filter by all three ids and the business. */
  loadMessage(tenantId: string, conversationId: string, messageId: string): Promise<MediaMessage | null>;
  /** The active connection of this business for the chat's channel, with its encrypted token, or null. */
  loadConnection(tenantId: string, channelId: string): Promise<{ connectionId: string; tokenEnc: string } | null>;
  /** Overwrites one message's media (for this business only). */
  saveMedia(tenantId: string, messageId: string, media: Record<string, unknown>): Promise<void>;
  /** Writes the object, replacing one at the same path. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  fetch: typeof fetch;
  env: Pick<ServerEnv, "ENCRYPTION_KEY" | "META_GRAPH_API_VERSION">;
  timeoutMs?: number;
  now?: () => Date;
}

export type DownloadOutcome =
  | { status: "stored" }
  /** Already saved, or already decided: nothing was called. */
  | { status: "done" }
  | { status: "skipped"; reason: string }
  | { status: "unavailable"; reason: string };

/** A failure that may pass (a timeout, a busy Meta, storage down). The text is fixed: it holds nothing from the failure. */
export class MediaRetryError extends Error {
  constructor(readonly reason: "timeout" | "network" | "busy" | "upload" | "record" | "lookup") {
    super(`media download will retry (${reason})`);
    this.name = "MediaRetryError";
  }
}

/** The end of the road for this message. `mark`: write the reason on the message, so no later run asks Meta again. */
class Stop {
  constructor(
    readonly status: "skipped" | "unavailable",
    readonly reason: string,
    readonly mark: boolean,
  ) {}
}

const Ids = z.object({ tenantId: z.guid(), conversationId: z.guid(), messageId: z.guid() });
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const Lookup = z.object({ url: z.string(), mime_type: z.string(), file_size: z.union([z.number(), z.string()]).optional() });

const baseType = (mime: string) => mime.split(";")[0].trim().toLowerCase();

/** The first bytes a file of this type starts with. Types without a rule here (text, Office) only have to be non-empty. */
function looksLike(mime: string, bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const starts = (...head: number[]) => head.every((b, i) => bytes[i] === b);
  switch (mime) {
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/webp":
      return starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((b, i) => bytes[8 + i] === b);
    case "application/pdf":
      return starts(0x25, 0x50, 0x44, 0x46, 0x2d);
    default:
      return true;
  }
}

/** A plain public https address with a name (no address literal, no login, no single-label host): the token is never sent anywhere else. */
function safeAddress(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || /^\d+(\.\d+){0,3}$/.test(host) || !host.includes(".") || /\.(local|internal|localhost)$/.test(host)) return null;
  return url;
}

/** One authenticated GET with a deadline that covers the whole answer, body included. Any failure that may pass becomes a MediaRetryError. */
async function get<T>(deps: DownloadDeps, url: string, token: string, onAnswer: (res: Response) => Promise<T>): Promise<T> {
  try {
    return await withTimeout(async (signal) => {
      const res = await deps.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal });
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => undefined);
        throw new Stop("skipped", "token_rejected", false);
      }
      if (res.status === 404 || res.status === 410 || res.status === 400) {
        await res.body?.cancel().catch(() => undefined);
        throw new Stop("unavailable", "media_gone", true);
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        throw new MediaRetryError("busy");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Stop("unavailable", "rejected", true);
      }
      return onAnswer(res);
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof Stop || err instanceof MediaRetryError) throw err;
    throw new MediaRetryError(err instanceof TimeoutError ? "timeout" : "network");
  }
}

/** The body, read in pieces and counted: it stops, and the rest is dropped, the moment it passes the cap. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw new Stop("skipped", "too_big", true);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Stop("skipped", "too_big", true);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function downloadMessageMedia(input: { tenantId: string; conversationId: string; messageId: string }, deps: DownloadDeps): Promise<DownloadOutcome> {
  const { tenantId, conversationId, messageId } = Ids.parse(input);

  const message = await deps.loadMessage(tenantId, conversationId, messageId).catch(() => {
    throw new MediaRetryError("lookup"); // whatever the database said stays out of the error Inngest prints
  });
  if (!message) return { status: "skipped", reason: "not_found" };
  const kind = message.kind;
  if (kind !== "image" && kind !== "document") return { status: "skipped", reason: "not_media" };
  const media = message.media ?? {};
  if (typeof media.path === "string" || typeof media.skipped === "string" || typeof media.unavailable === "string") return { status: "done" };
  const mediaId = media.id;
  if (typeof mediaId !== "string" || !MEDIA_ID.test(mediaId)) return { status: "skipped", reason: "no_media_id" };

  try {
    const connection = await deps.loadConnection(tenantId, message.channelId).catch(() => {
      throw new MediaRetryError("lookup");
    });
    if (!connection) return { status: "skipped", reason: "no_connection" };
    let token: string;
    try {
      token = decryptSecret(connection.tokenEnc, connectionSecretContext({ column: "token_enc", tenantId, connectionId: connection.connectionId }), deps.env);
    } catch {
      return { status: "skipped", reason: "token_unusable" };
    }
    if (token === "" || !/^v\d+\.\d+$/.test(String(deps.env.META_GRAPH_API_VERSION))) return { status: "skipped", reason: "token_unusable" };

    const lookup = await get(deps, `${GRAPH_URL}/${deps.env.META_GRAPH_API_VERSION}/${mediaId}`, token, async (res) => {
      const parsed = Lookup.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new Stop("unavailable", "bad_answer", true);
      return parsed.data;
    });

    const mime = baseType(lookup.mime_type);
    if (!ALLOWED[kind].includes(mime)) throw new Stop("skipped", "type_not_allowed", true);
    const cap = MAX_BYTES[kind];
    const declared = typeof lookup.file_size === "number" ? lookup.file_size : /^\d+$/.test(lookup.file_size ?? "") ? Number(lookup.file_size) : undefined;
    if (declared !== undefined && declared > cap) throw new Stop("skipped", "too_big", true);
    const address = safeAddress(lookup.url);
    if (!address) throw new Stop("unavailable", "bad_answer", true);

    const bytes = await get(deps, address.toString(), token, (res) => readCapped(res, cap));
    if (!looksLike(mime, bytes)) throw new Stop("skipped", "type_not_allowed", true);

    const path = messageMediaPath(tenantId, conversationId, messageId, mediaExtension(mime));
    try {
      await deps.upload(path, bytes, mime);
    } catch {
      throw new MediaRetryError("upload");
    }
    try {
      await deps.saveMedia(tenantId, messageId, { ...media, path, size: bytes.length, storedAt: (deps.now?.() ?? new Date()).toISOString() });
    } catch {
      throw new MediaRetryError("record");
    }
    return { status: "stored" };
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    if (err.mark) {
      try {
        await deps.saveMedia(tenantId, messageId, { ...media, [err.status]: err.reason });
      } catch {
        throw new MediaRetryError("record");
      }
    }
    return { status: err.status, reason: err.reason };
  }
}

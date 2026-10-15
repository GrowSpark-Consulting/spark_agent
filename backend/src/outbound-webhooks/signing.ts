import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// How a receiver knows a request came from us (docs/contracts.md, "Outbound webhooks"). Every request carries
//   X-Pakka-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed with the business's secret>
// The receiver recomputes it over the raw body, compares in constant time, and refuses a t more than 5 minutes old (a
// replayed request). verifySignature below is that check, for our tests and for the receiver's developers to copy.

export const SIGNATURE_HEADER = "x-pakka-signature";
export const TOLERANCE_SECONDS = 300;

/** A new signing secret: whsec_ and 32 random bytes. */
export function newSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** The last 4 characters, shown so the owner can tell which secret the receiver has. */
export function secretHint(secret: string): string {
  return secret.slice(-4);
}

const hmac = (secret: string, timestamp: number, body: string) => createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

export function signatureHeader(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

export function verifySignature(secret: string, body: string, header: string | null, nowSeconds: number): boolean {
  const parts = new Map((header ?? "").split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1") ?? "";
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > TOLERANCE_SECONDS || !/^[0-9a-f]{64}$/.test(v1)) return false;
  return timingSafeEqual(Buffer.from(v1, "hex"), Buffer.from(hmac(secret, t, body), "hex"));
}

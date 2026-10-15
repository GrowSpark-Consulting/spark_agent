import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newSigningSecret, secretHint, signatureHeader, verifySignature } from "./signing";

const SECRET = "whsec_test-secret-for-signing-0000000000000000";
const BODY = '{"id":"e1","type":"lead.created"}';
const NOW = 1_760_000_000;

describe("signing", () => {
  it("makes a whsec_ secret of 32 random bytes, different every time, and shows its last 4 characters", () => {
    const a = newSigningSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(newSigningSecret()).not.toBe(a);
    expect(secretHint(a)).toBe(a.slice(-4));
  });

  it("signs t.<raw body> with HMAC-SHA256, as a receiver can recompute it", () => {
    const expected = createHmac("sha256", SECRET).update(`${NOW}.${BODY}`).digest("hex");
    expect(signatureHeader(SECRET, BODY, NOW)).toBe(`t=${NOW},v1=${expected}`);
  });

  it("verifies its own signature within 5 minutes", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(verifySignature(SECRET, BODY, header, NOW)).toBe(true);
    expect(verifySignature(SECRET, BODY, header, NOW + 300)).toBe(true);
  });

  it.each([
    ["a changed body", SECRET, `${BODY} `, NOW],
    ["another secret", "whsec_other", BODY, NOW],
    ["an old request (replayed)", SECRET, BODY, NOW + 301],
    ["a request from the future", SECRET, BODY, NOW - 301],
  ])("refuses %s", (_name, secret, body, now) => {
    expect(verifySignature(secret, body, signatureHeader(SECRET, BODY, NOW), now)).toBe(false);
  });

  it.each([null, "", "t=abc,v1=00", `t=${NOW}`, `t=${NOW},v1=zz`, `t=${NOW},v1=${"0".repeat(63)}`])("refuses a malformed header %j", (header) => {
    expect(verifySignature(SECRET, BODY, header, NOW)).toBe(false);
  });
});

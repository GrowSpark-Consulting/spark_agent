import { describe, expect, it } from "vitest";
import { AppError } from "../../lib/errors";
import { createHandoffLinks, LINK_TTL_MS, signHandoffToken, verifyHandoffToken } from "./token";

// The link in a staff alert (docs/handover.md, module 6): /h/{token}?mode=inbox and ?mode=own. The token is signed, tied to ONE staff member and ONE
// handoff, and good for 24 hours. It carries ids only (never a name, a number or a word of the chat). Whether it has been used is the handoff's own
// state (takeover.ts), not the token's.

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const env = { ENCRYPTION_KEY: KEY };
const NOW = new Date("2026-10-11T12:00:00.000Z");
const claims = { tenantId: "e0000000-0000-4000-8000-00000000000a", handoffId: "a1000000-0000-4000-8000-000000000001", userId: "f1000000-0000-4000-8000-000000000001" };

describe("a handoff token", () => {
  it("brings back who it was made for, which handoff and which business", () => {
    expect(verifyHandoffToken(signHandoffToken(claims, env, NOW), env, NOW)).toEqual({ status: "ok", claims });
  });

  it("is good for 24 hours, and not a moment more", () => {
    const token = signHandoffToken(claims, env, NOW);
    expect(verifyHandoffToken(token, env, new Date(NOW.getTime() + LINK_TTL_MS)).status).toBe("ok");
    expect(verifyHandoffToken(token, env, new Date(NOW.getTime() + LINK_TTL_MS + 1))).toEqual({ status: "expired" });
    expect(LINK_TTL_MS).toBe(24 * 60 * 60_000);
  });

  it("is different every time it is made, for the same person and handoff", () => {
    expect(signHandoffToken(claims, env, NOW)).not.toBe(signHandoffToken(claims, env, NOW));
  });

  it("carries ids and a time only: nothing a person could read in it", () => {
    const [payload] = signHandoffToken(claims, env, NOW).split(".");
    const text = Buffer.from(payload, "base64url").toString("utf8");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["exp", "h", "n", "t", "u"]);
    expect(text).not.toMatch(/phone|name|@|\+91/i);
  });

  it("is made of characters that are safe in a link", () => {
    expect(signHandoffToken(claims, env, NOW)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("a token that is not right", () => {
  const token = signHandoffToken(claims, env, NOW);
  const [payload, mac] = token.split(".");
  const forged = (change: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), ...change })).toString("base64url");

  it("changed to name another staff member, another handoff or another business is refused (the signature no longer fits)", () => {
    for (const change of [{ u: "f1000000-0000-4000-8000-000000000002" }, { h: "a1000000-0000-4000-8000-000000000002" }, { t: "e0000000-0000-4000-8000-00000000000b" }]) {
      expect(verifyHandoffToken(`${forged(change)}.${mac}`, env, NOW)).toEqual({ status: "invalid" });
    }
  });

  it("with a longer life written into it is refused too", () => {
    expect(verifyHandoffToken(`${forged({ exp: NOW.getTime() + 10 * LINK_TTL_MS })}.${mac}`, env, NOW)).toEqual({ status: "invalid" });
  });

  it("signed with another key (another environment) is refused", () => {
    expect(verifyHandoffToken(token, { ENCRYPTION_KEY: OTHER_KEY }, NOW)).toEqual({ status: "invalid" });
  });

  it("not even shaped like a token is refused without an error", () => {
    for (const text of ["", ".", "abc", "a.b.c", `${payload}.`, `.${mac}`, `${payload}.${mac}x`, "x".repeat(5000), "💥.💥", "%00.%00"]) {
      expect(verifyHandoffToken(text, env, NOW)).toEqual({ status: "invalid" });
    }
  });

  it("whose signature is right but whose contents are not ids is refused", () => {
    // Only possible to make with the key: shows that the contents are checked as well as the signature.
    const bad = Buffer.from(JSON.stringify({ t: "x", h: "y", u: "z", exp: NOW.getTime() + 1000, n: "n" })).toString("base64url");
    const good = signHandoffToken(claims, env, NOW);
    expect(verifyHandoffToken(`${bad}.${good.split(".")[1]}`, env, NOW)).toEqual({ status: "invalid" });
  });

  it("is refused when the server has no key, rather than accepted", () => {
    expect(verifyHandoffToken(token, {}, NOW)).toEqual({ status: "invalid" });
  });
});

describe("no key", () => {
  it("a token cannot be made without the server's key: it says so plainly", () => {
    expect(() => signHandoffToken(claims, {}, NOW)).toThrow(AppError);
    expect(() => signHandoffToken(claims, {}, NOW)).toThrow(/switched on/i);
  });
});

describe("the two links of an alert", () => {
  const withUrls = { ...env, API_PUBLIC_URL: "https://api.example.test" };

  it("the inbox link and, on a plan that has it, the own-number link, to the API's own address", () => {
    const links = createHandoffLinks(claims, withUrls, NOW, { ownNumber: true });
    expect(links.inbox).toMatch(/^https:\/\/api\.example\.test\/h\/[A-Za-z0-9_.-]+\?mode=inbox$/);
    expect(links.own).toMatch(/^https:\/\/api\.example\.test\/h\/[A-Za-z0-9_.-]+\?mode=own$/);
  });

  it("both carry the same token, so using one ends the other: one takeover per handoff", () => {
    const links = createHandoffLinks(claims, withUrls, NOW, { ownNumber: true });
    const token = (url: string | null) => new URL(url ?? "").pathname.split("/")[2];
    expect(token(links.inbox)).toBe(token(links.own));
  });

  it("on a plan without own-number takeover there is no own-number link at all", () => {
    expect(createHandoffLinks(claims, withUrls, NOW, { ownNumber: false }).own).toBeNull();
  });

  it("the tokens verify", () => {
    const links = createHandoffLinks(claims, withUrls, NOW, { ownNumber: true });
    expect(verifyHandoffToken(new URL(links.inbox).pathname.split("/")[2], env, NOW)).toEqual({ status: "ok", claims });
  });

  it("is not available when the API's address is not set", () => {
    expect(() => createHandoffLinks(claims, env, NOW, { ownNumber: true })).toThrow(/switched on/i);
  });
});

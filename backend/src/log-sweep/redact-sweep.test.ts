import { describe, expect, it } from "vitest";
import { errorKind } from "../lib/errors";
import { errorTextForLog, redactForLog } from "../lib/redact";
import { findLeaks, phoneForms, type Fixtures } from "./detect";

// Day 7, PR B follow-up: the text helpers that Dev 2's code puts in front of a log line (lib/redact.ts redactForLog and errorTextForLog, used by billing, deletion
// and notify.send) and the error envelope's errorKind (lib/errors.ts), checked as the log sweep checks everything: with synthetic secrets, phone numbers in every
// written form, emails and canary words. EVERY value is a synthetic one made here. What each helper does NOT remove is pinned too, so nobody believes it removes more.

const PHONE = "+919812345621";
const TOKEN = "Zm9vYmFyLXN5bnRoZXRpYy10b2tlbi1mb3ItdGVzdHM"; // 43 characters: the shape of a connect-link token
const ANTHROPIC = "sk-ant-api03-synthetic-fixture-key-000000";
const APP_SECRET = "synthetic-meta-app-secret";
const ENCRYPTION = "synthetic-encryption-key-0123456789abcdef";
const FX: Fixtures = { phones: [PHONE], secrets: [TOKEN, ANTHROPIC, APP_SECRET, ENCRYPTION], texts: ["CANARY-WORDS-7QX"] };

/** [what it is, the whole text as it appears in a message, the sensitive part itself (which must be gone even if only a label or a prefix of the text is removed)]. */
const CREDENTIALS: [string, string, string][] = [
  ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk", "eyJzdWIiOiIxMjM0NTY3ODkwIn0"],
  ["a Meta access token", "EAAGm0PX4ZCpsBAKexampleexampleexample123", "exampleexampleexample123"],
  ["a bearer header", "Authorization: Bearer abc123def456ghi", "abc123def456ghi"],
  ["a connection string with a password", "postgres://user:hunter2@db.example.test/app", "hunter2"],
  ["a Supabase key", "sb_secret_abcdefghijklmnop", "abcdefghijklmnop"],
];

describe("redactForLog and errorTextForLog: what they remove", () => {
  it.each(CREDENTIALS)("%s", (_name, whole, sensitive) => {
    for (const out of [redactForLog(`call failed: ${whole}`), errorTextForLog(new Error(`call failed: ${whole}`)), errorTextForLog(`call failed: ${whole}`)]) {
      // the sensitive part itself, and the whole text, are gone
      expect(findLeaks([out], { phones: [], secrets: [whole, sensitive], texts: [] }), out).toEqual([]);
      expect(out).not.toContain(sensitive);
      expect(out).toContain("call failed");
    }
  });

  it("a phone number in every written form, in an error message and in plain text", () => {
    for (const form of phoneForms(PHONE)) {
      for (const out of [redactForLog(`refund for ${form} failed`), errorTextForLog(new Error(`duplicate key (phone)=(${form}) already exists`))]) {
        expect(findLeaks([out], { phones: [PHONE], secrets: [], texts: [] }), `${form} -> ${out}`).toEqual([]);
        expect(out).not.toContain(form);
      }
    }
  });

  it("the Anthropic key, a connect-link token and a long app or encryption key are removed (a known prefix, or 32 or more key characters in a row)", () => {
    for (const secret of [ANTHROPIC, TOKEN, ENCRYPTION, "0123456789abcdef0123456789abcdef"]) {
      expect(redactForLog(`failed: ${secret}`), secret).not.toContain(secret);
    }
  });

  it("an email address, and several things in one message", () => {
    const out = redactForLog(`failed for asha@example.com at ${PHONE} with Bearer abc.def.ghi and ${CREDENTIALS[1][1]}`);
    expect(out).not.toMatch(/asha@example\.com|abc\.def\.ghi|EAAGm0PX4ZCp/);
    expect(findLeaks([out], { phones: [PHONE], secrets: [], texts: [] })).toEqual([]);
  });

  it("an Error with a message, and a non-Error value (a string, a number, null, an object), each as text and redacted", () => {
    expect(errorTextForLog(new Error(`x ${PHONE}`))).not.toContain(PHONE);
    expect(errorTextForLog(`x ${PHONE}`)).not.toContain(PHONE);
    expect(errorTextForLog(404)).toBe("404");
    expect(errorTextForLog(null)).toBe("null");
    expect(errorTextForLog({ toString: () => `object ${PHONE}` })).not.toContain(PHONE);
  });

  it("is a no-op on ordinary words, a UUID and a masked number (nothing useful for staff or a developer is lost)", () => {
    const line = "booking 9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b not found for +9198xxxxxx21";
    expect(redactForLog(line)).toBe(line);
  });

  it("is safe to run twice, and fast on a very long message", () => {
    const once = redactForLog(`a ${PHONE} b Bearer abc.def.ghi`);
    expect(redactForLog(once)).toBe(once);
    const started = Date.now();
    redactForLog("x".repeat(500_000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("redactForLog and errorTextForLog: what they do NOT remove (pinned; the callers log constrained messages only)", () => {
  it("a customer's own words are not removed: these helpers are for an error's message, never for a message the customer wrote", () => {
    expect(redactForLog("could not store: CANARY-WORDS-7QX")).toContain("CANARY-WORDS-7QX");
  });

  it("KNOWN LIMIT: a secret of under 32 characters with no known prefix is not recognised; real Meta app secrets are 32 hex characters, so they are removed", () => {
    // Recorded, not a leak of ours (lib/redact.ts and redactSecrets in packages/types are Dev 2's, and none of the five call sites logs such a value).
    expect(redactForLog(`failed: ${APP_SECRET}`)).toContain(APP_SECRET);
  });
});

describe("errorKind: the error's name and a short code only", () => {
  class PgError extends Error {
    constructor(message: string, readonly code?: unknown) {
      super(message);
      this.name = "PgError";
    }
  }

  it("never its message, whatever the message carries", () => {
    const poison = `${PHONE} ${ANTHROPIC} ${APP_SECRET} ${TOKEN} CANARY-WORDS-7QX asha@example.com`;
    for (const err of [new Error(poison), new PgError(poison, "23505"), new TypeError(poison)]) {
      const kind = errorKind(err);
      expect(findLeaks([kind], FX), kind).toEqual([]);
      expect(kind).not.toContain("asha@example.com");
    }
  });

  it("the name, and a code when it is a short plain one (a Postgres SQLSTATE, a Node error code)", () => {
    expect(errorKind(new PgError("x", "23505"))).toBe("PgError (23505)");
    expect(errorKind(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("Error (ECONNRESET)");
    expect(errorKind(new RangeError("x"))).toBe("RangeError");
  });

  it("a code that is not short plain text is dropped (a code can carry a message too)", () => {
    for (const code of [`23505 ${PHONE}`, "x".repeat(33), "has space", `+${PHONE}`, "a-b", 23505, null, undefined, {}]) {
      const kind = errorKind(new PgError("x", code));
      expect(kind, String(code)).toBe("PgError");
    }
  });

  it("KNOWN LIMIT: a code that is itself plain letters and digits is printed whatever it is, so a phone number used as a code (without a plus or a space) would be; real codes are SQLSTATEs and Node codes", () => {
    expect(errorKind(new PgError("x", "919812345621"))).toBe("PgError (919812345621)");
  });

  it("a value that is not an Error is named by its type, never printed", () => {
    expect(errorKind(`${PHONE} ${ANTHROPIC}`)).toBe("a thrown string");
    expect(errorKind(404)).toBe("a thrown number");
    expect(errorKind(null)).toBe("a thrown null");
    expect(errorKind(undefined)).toBe("a thrown undefined");
    expect(errorKind({ message: PHONE })).toBe("a thrown object");
    expect(errorKind(Symbol("x"))).toBe("a thrown symbol");
  });

  it("an error whose NAME was set from outside text is the one thing it prints: names in our code are fixed class names", () => {
    expect(errorKind(Object.assign(new Error("x"), { name: "ZodError" }))).toBe("ZodError");
  });
});

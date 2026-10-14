import { afterEach, describe, expect, it } from "vitest";
import { captureLogs, describeLeaks, findLeaks, phoneForms, poison, type Fixtures } from "./detect";

// The detectors of the log sweep, tested on planted leaks: a sweep that cannot see a leak proves nothing. Every value here is synthetic.

const FX: Fixtures = {
  phones: ["+919812345621"],
  secrets: ["synthetic-meta-app-secret", "k3Qz-fixture-connect-link-token-AAAAAAAA"],
  texts: ["CANARY-WORDS-7QX", "Priya Canary"],
};

const kinds = (line: string, fx: Fixtures = FX) => findLeaks([line], fx).map((l) => l.kind);

describe("what it catches", () => {
  it.each(phoneForms("+919812345621"))("the fixture's number written as %s", (form) => {
    expect(kinds(`message from ${form} stored`)).toContain("phone");
  });

  it.each(["call +14155552671 now", "from 91 98123 45621", "wa 09812345621", "number=9876543210"])("a phone-shaped run of digits that is not a fixture: %s", (line) => {
    expect(kinds(line)).toContain("phone");
  });

  it("each exact secret, wherever it is in the line", () => {
    expect(kinds("signature check with synthetic-meta-app-secret failed")).toContain("secret");
    expect(kinds("GET /api/connect-links/k3Qz-fixture-connect-link-token-AAAAAAAA 404")).toContain("secret");
  });

  it("each canary text", () => {
    expect(kinds("the customer wrote CANARY-WORDS-7QX")).toContain("text");
    expect(kinds("name Priya Canary")).toContain("text");
  });

  it.each([
    ["a JWT", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk"],
    ["a Meta access token", "using EAAGm0PX4ZCpsBAKexampleexampleexample123"],
    ["an Anthropic key", "key sk-ant-api03-abcdefghijklmnop"],
    ["a Supabase key", "key sb_secret_abcdefghij"],
    ["a bearer header", "Authorization: Bearer abc123def456ghi"],
    ["a connection string", "postgres://user:hunter2@db.example.test/app"],
    ["a 43-character token", "path /h/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc"],
    ["a 64-character hex key", "key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
  ])("%s", (_name, line) => {
    expect(kinds(line)).toContain("token");
  });

  it("says what it found and where, and only the synthetic value", () => {
    const leaks = findLeaks(["[pipeline] +919812345621 wrote CANARY-WORDS-7QX"], FX);
    expect(describeLeaks(leaks)).toContain("+919812345621");
    expect(describeLeaks(leaks)).toContain("CANARY-WORDS-7QX");
  });
});

describe("what it lets through", () => {
  it.each([
    "[pipeline] replied: answered_from_kb; sent",
    "[whatsapp-webhook] messages=1 stored=1 duplicates=0 echoes=0",
    "POST /api/webhooks/whatsapp 200 12ms",
    "GET /api/connect-links/*** 404 3ms",
    "[pipeline] gave up after its retries on message a0000000-0000-4000-8000-0000000000a1 (Error)",
    "2026-10-14T10:20:30.123Z [server] listening on http://0.0.0.0:4000",
    "connection 11111111-1111-4111-8111-111111111111 token ok, rating GREEN, limit TIER_1K",
  ])("an ordinary line: %s", (line) => {
    expect(kinds(line)).toEqual([]);
  });

  it("a masked number", () => {
    expect(kinds("customer +9198xxxxxx21 opted out")).toEqual([]);
    expect(kinds("customer xxxxxxxx21")).toEqual([]);
  });

  it("short numbers: counts, prices, times, ports", () => {
    expect(kinds("balance 12 credits, price 7800000, port 4000, 3 retries, 1250ms")).toEqual([]);
  });
});

describe("captureLogs", () => {
  let capture: ReturnType<typeof captureLogs> | undefined;
  afterEach(() => capture?.stop());

  it("collects what the code writes with console.*, formatted like console would, and prints nothing", () => {
    capture = captureLogs();
    console.log("a", 1, { b: 2 });
    console.error("e");
    console.warn("w");
    console.info("i");
    console.debug("d");
    expect(capture.lines()).toEqual(["a 1 { b: 2 }", "e", "w", "i", "d"]);
    expect(capture.entries.map((e) => e.source)).toEqual(["console.log", "console.error", "console.warn", "console.info", "console.debug"]);
  });

  it("collects the lines a code path hands to a log callback", () => {
    capture = captureLogs();
    capture.log("GET /x 200 1ms");
    expect(capture.entries).toEqual([{ source: "log callback", line: "GET /x 200 1ms" }]);
  });

  it("finds a leak in what was captured, and stops capturing when told", () => {
    capture = captureLogs();
    console.log(`bad ${FX.phones[0]}`);
    expect(capture.leaks(FX).map((l) => l.kind)).toContain("phone");
    capture.stop();
    console.log("after stop");
    expect(capture.lines()).toHaveLength(1);
  });
});

describe("poison", () => {
  it("is a message with every fixture secret, number and text in it, so any code that prints an error's message is caught", () => {
    const message = poison(FX);
    expect(kinds(message)).toEqual(expect.arrayContaining(["phone", "secret", "text"]));
  });
});

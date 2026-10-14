import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logPathFor } from "../server/app";
import { createHttpServer } from "../server/node";
import { toErrorResponse } from "../lib/errors";
import { captureLogs, describeLeaks, findLeaks, poison, type Fixtures, type LogCapture } from "./detect";

// The request logger (server/node.ts: `METHOD path status ms`) and the lines for an unexpected error, tested with what a client can send: the paths with a
// secret in them (a connect-link token, a hand-over link token), addresses that match no route (a trailing slash, an extra segment, a double slash, another
// letter case, an encoded slash), query strings, a phone number in a path, and a route handler that throws an error whose message carries secrets.
// Every value is synthetic.
//
// CLOSED 14 Oct (Dev 2, #202): logPathFor masks any run of 32+ key characters wherever a mangled path puts it (server/app.ts); the two
// "unexpected error" lines log the error's name and a short code only, never the message (lib/errors.ts errorKind, server/node.ts). The
// tests below, flipped from KNOWN LEAK to ordinary assertions of no leak, are the record of that.

const TOKEN = "Zm9vYmFyLXN5bnRoZXRpYy10b2tlbi1mb3ItdGVzdHM"; // 43 characters, the shape of a connect-link token
const PHONE = "+919812345621";
const ANTHROPIC_KEY = "sk-ant-api03-synthetic-fixture-key-000000";
const FX: Fixtures = {
  phones: [PHONE],
  secrets: [TOKEN, "synthetic-meta-app-secret", ANTHROPIC_KEY, "synthetic-encryption-key-0123456789abcdef"],
  texts: ["CANARY-WORDS-7QX"],
};

let capture: LogCapture;
beforeEach(() => void (capture = captureLogs()));
afterEach(() => capture.stop());

// ---------------------------------------------------------------------------------------------------------------------
// Paths that are masked today

const MASKED: [string, string][] = [
  ["the connect-link route", `/api/connect-links/${TOKEN}`],
  ["the connect-link route with a trailing slash", `/api/connect-links/${TOKEN}/`],
  ["the connect-link route with an extra segment", `/api/connect-links/${TOKEN}/extra`],
  ["the connect-link route with an encoded slash in front of the token", `/api/connect-links/%2F${TOKEN}`],
  ["the hand-over link", `/h/${TOKEN}`],
  ["the hand-over link with a trailing slash", `/h/${TOKEN}/`],
  ["the hand-over link with two extra segments", `/h/${TOKEN}/a/b`],
];

// Paths whose token is written to the log today (see the KNOWN LEAK tests below).
const LEAKING: [string, string][] = [
  ["a double slash in front (a trailing slash in the API address the browser was given)", `//api/connect-links/${TOKEN}`],
  ["a double slash inside", `/api//connect-links/${TOKEN}`],
  ["a double slash in front of the hand-over link (API_PUBLIC_URL with a trailing slash)", `//h/${TOKEN}`],
  ["a double slash after the hand-over prefix", `/h//${TOKEN}`],
  ["another letter case in the prefix", `/API/connect-links/${TOKEN}`],
  ["another letter case in the route", `/api/Connect-Links/${TOKEN}`],
  ["an encoded slash after the prefix", `/api/connect-links%2F${TOKEN}`],
  ["a semicolon parameter", `/api/connect-links;v=1/${TOKEN}`],
];

describe("logPathFor: a path with a secret in it is masked", () => {
  it.each(MASKED)("%s", (_name, address) => {
    const shown = logPathFor(address);
    expect(findLeaks([shown], FX), `logged as ${shown}\n`).toEqual([]);
  });

  it("an ordinary path is shown as it is", () => {
    expect(logPathFor("/api/webhooks/whatsapp")).toBe("/api/webhooks/whatsapp");
    expect(logPathFor("/api/billing/balance")).toBe("/api/billing/balance");
  });
});

describe("logPathFor: a mangled path (double slash, letter case, an encoded slash, a ;param) is masked too", () => {
  it.each(LEAKING)("%s", (_name, address) => {
    const shown = logPathFor(address);
    expect(findLeaks([shown], FX), `logged as ${shown}`).toEqual([]);
  });
});

/** Sends one request, with exactly this address, to a server that logs like the real one (createHttpServer with logPathFor) and answers with `handle`. */
async function logged(address: string, handle: (request: Request) => Response | Promise<Response> = () => new Response("not found", { status: 404 })): Promise<void> {
  const server: Server = createHttpServer(async (request) => handle(request), { logPath: (pathname) => logPathFor(pathname), log: capture.log });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: address, method: "GET" }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });
    // the line is written after the response has been sent: wait for it (up to 2 seconds), never a fixed pause
    for (let waited = 0; capture.lines().length === 0 && waited < 2000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(capture.lines().length, "the request logger wrote no line: the check below would prove nothing").toBeGreaterThan(0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("the request logger, through a real server", () => {
  it("logs method, path, status and time, and nothing else", async () => {
    await logged("/api/billing/balance");
    expect(capture.lines()).toHaveLength(1);
    expect(capture.lines()[0]).toMatch(/^GET \/api\/billing\/balance 404 \d+ms$/);
  });

  it("never logs the query string: a token, a number or a text in it does not appear", async () => {
    await logged(`/api/billing/balance?token=${TOKEN}&phone=${encodeURIComponent(PHONE)}&text=CANARY-WORDS-7QX`);
    expect(capture.leaks(FX), describeLeaks(capture.leaks(FX))).toEqual([]);
    expect(capture.lines()[0]).toMatch(/^GET \/api\/billing\/balance 404/);
  });

  it.each(MASKED)("%s: nothing secret is written to the log", async (_name, address) => {
    await logged(address);
    expect(capture.leaks(FX), describeLeaks(capture.leaks(FX))).toEqual([]);
  });

  it("through a real server: a double slash in front of the hand-over link no longer writes the token to the access log", async () => {
    await logged(`//h/${TOKEN}`);
    expect(capture.leaks(FX), describeLeaks(capture.leaks(FX))).toEqual([]);
  });

  it("through a real server: another letter case no longer writes the token to the access log", async () => {
    await logged(`/API/connect-links/${TOKEN}`);
    expect(capture.leaks(FX), describeLeaks(capture.leaks(FX))).toEqual([]);
  });

  it("KNOWN LIMIT: the logger prints whatever path a client asks for, so a phone number in an address no route of ours takes is logged (no route takes one; recorded, not a leak of ours)", async () => {
    await logged(`/api/whatsapp/${encodeURIComponent(PHONE)}/x`);
    expect(capture.lines().join("\n")).toContain(encodeURIComponent(PHONE));
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("what redactSecrets already removes from an unexpected error", () => {
  const lines = (message: string) => {
    const out: string[] = [];
    toErrorResponse(new Error(message), (line) => void out.push(line));
    return out;
  };

  it.each([
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk"],
    ["a Meta access token", "EAAGm0PX4ZCpsBAKexampleexampleexample123"],
    ["a bearer header", "Authorization: Bearer abc123def456ghi"],
    ["a connection string with a password", "postgres://user:hunter2@db.example.test/app"],
    ["a Supabase key", "sb_secret_abcdefghijklmnop"],
  ])("%s", (_name, secret) => {
    const out = lines(`call failed: ${secret}`);
    expect(out).toHaveLength(1);
    expect(findLeaks(out, { phones: [], secrets: [secret], texts: [] })).toEqual([]);
  });
});

describe("an unexpected error's message no longer reaches the log (errorKind: the error's name and a short code only)", () => {
  it("the error envelope logs no phone number, key, secret or text the message carried", () => {
    const out: string[] = [];
    const { status } = toErrorResponse(new Error(poison(FX)), (line) => void out.push(line));
    expect(status).toBe(500);
    expect(findLeaks(out, FX), describeLeaks(findLeaks(out, FX))).toEqual([]);
    expect(out[0]).not.toContain(PHONE);
    expect(out[0]).not.toContain(ANTHROPIC_KEY);
  });

  it("the same for a database-style message with a phone in the detail (what a unique violation says)", () => {
    const out: string[] = [];
    toErrorResponse(new Error(`duplicate key value violates unique constraint "contacts_tenant_phone_key" Key (tenant_id, phone)=(e0000000, ${PHONE}) already exists.`), (line) => void out.push(line));
    expect(out[0]).not.toContain(PHONE);
  });

  it("an error that is not an Error object (a string a library threw) is logged whole, but names its kind only, nothing it carried", () => {
    const out: string[] = [];
    toErrorResponse(poison(FX), (line) => void out.push(line));
    expect(findLeaks(out, FX)).toEqual([]);
  });

  it("a route handler that throws: the server's own line carries no secret either (server/node.ts)", async () => {
    await logged("/api/billing/balance", () => {
      throw new Error(poison(FX));
    });
    const line = capture.lines().find((l) => l.startsWith("[server] unexpected error"));
    expect(line).toBeDefined();
    expect(line).not.toContain(PHONE);
    expect(line).not.toContain(ANTHROPIC_KEY);
  });
});

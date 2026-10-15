import { describe, expect, it, vi } from "vitest";
import { inRequestScope, reportError, reportProblem, sentryTarget, stackFrames, type ReportDeps } from "./report";

const DSN = "https://abc123key@o1.ingest.sentry.io/4507";
const NOW = new Date("2026-10-15T06:00:00Z");
const sent = () => {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response("{}", { status: 200 }));
  const deps: ReportDeps = { dsn: DSN, fetch: fetch as unknown as typeof globalThis.fetch, now: () => NOW };
  const event = () => JSON.parse(String(fetch.mock.calls[0][1].body).split("\n")[2]);
  return { fetch, deps, event };
};

describe("sentryTarget", () => {
  it("builds the envelope URL and key from a DSN", () => {
    expect(sentryTarget(DSN)).toEqual({ url: "https://o1.ingest.sentry.io/api/4507/envelope/", key: "abc123key" });
    expect(sentryTarget("https://k@host.example/prefix/12")).toEqual({ url: "https://host.example/prefix/api/12/envelope/", key: "k" });
  });
  it.each(["", "not a url", "http://k@h/1", "https://h/1", "https://k@h/notdigits"])("refuses %j", (dsn) => expect(sentryTarget(dsn)).toBeNull());
});

describe("stackFrames", () => {
  it("keeps code locations only, oldest first, and marks node_modules as not ours", () => {
    const frames = stackFrames("Error: secret +919812345621\n    at doIt (file:///D:/app/backend/src/x/y.ts:10:5)\n    at async /app/node_modules/foo/i.js:3:1");
    expect(frames).toEqual([
      { function: "?", filename: "node_modules/foo/i.js", lineno: 3, colno: 1, in_app: false },
      { function: "doIt", filename: "backend/src/x/y.ts", lineno: 10, colno: 5, in_app: true },
    ]);
    expect(JSON.stringify(frames)).not.toContain("9812345621");
  });
});

describe("reportError and reportProblem", () => {
  it("posts one envelope with the error's kind and its message with secrets and numbers masked", async () => {
    const { fetch, deps, event } = sent();
    await expect(reportError(new TypeError("failed for +919812345621 key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), { kind: "api_error", tags: { tenant: "t1" } }, deps)).resolves.toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://o1.ingest.sentry.io/api/4507/envelope/");
    expect(String(init.headers && (init.headers as Record<string, string>)["x-sentry-auth"])).toContain("sentry_key=abc123key");
    const e = event();
    expect(e.exception.values[0].type).toBe("TypeError");
    expect(JSON.stringify(e)).not.toMatch(/9812345621|sk-ant-api03/);
    expect(e.tags).toMatchObject({ kind: "api_error", tenant: "t1" });
  });

  it("names the route of the request it happens in, and marks the request as reported", async () => {
    const { deps, event } = sent();
    const scope = { route: "/api/kb/faqs/:id", method: "PATCH", reported: false };
    await inRequestScope(scope, () => reportProblem("a 500", { kind: "api_error" }, deps));
    expect(event().tags).toMatchObject({ route: "/api/kb/faqs/:id", method: "PATCH" });
    const other = { route: "/x", method: "GET", reported: false };
    await inRequestScope(other, () => reportError(new Error("x"), { kind: "api_error" }, sent().deps));
    expect(other.reported).toBe(true);
  });

  it("gives the same event id for the same key, a fresh one without", async () => {
    const a = sent(), b = sent(), c = sent(), d = sent();
    await reportProblem("p", { kind: "job_failed", eventKey: "job_failed:r1" }, a.deps);
    await reportProblem("p", { kind: "job_failed", eventKey: "job_failed:r1" }, b.deps);
    await reportProblem("p", { kind: "job_failed" }, c.deps);
    await reportProblem("p", { kind: "job_failed" }, d.deps);
    expect(a.event().event_id).toBe(b.event().event_id);
    expect(c.event().event_id).not.toBe(d.event().event_id);
  });

  it("sends nothing without a DSN, and never throws when Sentry is down or refuses", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetch, deps } = sent();
    await expect(reportProblem("p", { kind: "test" }, { ...deps, dsn: undefined })).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await expect(reportProblem("p", { kind: "test" }, { ...deps, fetch: vi.fn(async () => { throw new TypeError("fetch failed"); }) as never })).resolves.toBe(false);
    await expect(reportProblem("p", { kind: "test" }, { ...deps, fetch: vi.fn(async () => new Response("", { status: 429 })) as never })).resolves.toBe(false);
    quiet.mockRestore();
  });
});

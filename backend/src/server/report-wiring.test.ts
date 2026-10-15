import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "./routes";

const reportError = vi.fn(async () => true);
const reportProblem = vi.fn(async () => true);
vi.mock("../lib/report", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/report")>()),
  reportError: (...a: unknown[]) => reportError(...(a as [])),
  reportProblem: (...a: unknown[]) => reportProblem(...(a as [])),
}));

const { createApp } = await import("./app");
const { AppError } = await import("../lib/errors");

const routes: Route[] = [
  { path: "/api/boom/:id", methods: { GET: () => { throw new Error("db down for +919812345621"); } } },
  { path: "/api/refuse", methods: { GET: () => { throw new AppError("forbidden", "No."); } } },
  { path: "/api/answers-500", methods: { POST: () => new Response("x", { status: 500 }) } },
  { path: "/api/inngest", methods: { POST: () => new Response("x", { status: 500 }) } },
  { path: "/api/fine", methods: { GET: () => new Response("ok") } },
];
const app = createApp({ userClient: (() => undefined) as never, inngest: async () => Response.json({}), allowedOrigins: new Set() }, routes);
const call = (method: string, path: string) => app(new Request(`http://localhost:4000${path}`, { method }));

beforeEach(() => {
  reportError.mockClear();
  reportProblem.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("what the API sends to Sentry", () => {
  it("a thrown unexpected error is reported once, as the error", async () => {
    expect((await call("GET", "/api/boom/42")).status).toBe(500);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { kind: "api_error" });
    expect(reportProblem).not.toHaveBeenCalled();
  });

  it("a route that answers 500 itself is reported as a problem naming the route's pattern, not the path asked", async () => {
    await call("POST", "/api/answers-500");
    expect(reportProblem).toHaveBeenCalledWith("POST /api/answers-500 answered 500", { kind: "api_error" });
  });

  it("nothing for a refusal, a success, or Inngest's own 500s", async () => {
    await call("GET", "/api/refuse");
    await call("GET", "/api/fine");
    await call("POST", "/api/inngest");
    await call("GET", "/api/nowhere");
    expect(reportError).not.toHaveBeenCalled();
    expect(reportProblem).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /h/:token: how the route is wired (no login, no CORS, the token reaches the handler, and is hidden in the log). What a tap does is agent/handoff/takeover.test.ts.

const handleHandoffLink = vi.fn();
vi.mock("../agent/handoff/takeover", () => ({ handleHandoffLink: (...args: unknown[]) => handleHandoffLink(...args) }));

const { createApp } = await import("./app");

const app = createApp({ userClient: () => { throw new Error("no user client needed"); }, inngest: async () => Response.json({}), allowedOrigins: new Set(["https://app.pakkaagent.in"]) });

beforeEach(() => handleHandoffLink.mockReset());

describe("GET /h/:token", () => {
  it("hands the token from the path and the request to the handler, with no sign-in", async () => {
    handleHandoffLink.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://app.pakkaagent.in/dashboard/inbox" } }));
    const res = await app(new Request("http://localhost:4000/h/abc.def?mode=own"));
    expect(res.status).toBe(302);
    expect(handleHandoffLink).toHaveBeenCalledWith(expect.any(Request), { token: "abc.def" });
  });

  it("is a GET only", async () => {
    const res = await app(new Request("http://localhost:4000/h/abc.def", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(handleHandoffLink).not.toHaveBeenCalled();
  });
});

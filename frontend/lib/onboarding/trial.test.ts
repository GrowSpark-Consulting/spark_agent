import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const { startTrial } = await import("./trial");

beforeEach(() => {
  apiFetch.mockReset();
});

describe("startTrial", () => {
  it("sends only the name and the trade to the API", async () => {
    apiFetch.mockResolvedValue(Response.json({ status: "ready", trial: { routeCode: "TRIAL-7KQM", trialDays: 7, credits: 300 } }));
    const result = await startTrial({ name: "Sunrise Homes", industry: "re" });
    expect(apiFetch).toHaveBeenCalledWith("/api/onboarding/trial", { method: "POST", body: { name: "Sunrise Homes", industry: "re" } });
    expect(result).toEqual({ status: "ready", trial: { routeCode: "TRIAL-7KQM", trialDays: 7, credits: 300 } });
  });

  it("sends the typed WhatsApp number when there is one, and no phone key when there is not", async () => {
    apiFetch.mockResolvedValue(Response.json({ status: "ready", trial: { routeCode: "TRIAL-7KQM", trialDays: 7, credits: 300 } }));
    await startTrial({ name: "Sunrise Homes", industry: "re", phone: "+919876543210" });
    expect(apiFetch).toHaveBeenLastCalledWith("/api/onboarding/trial", { method: "POST", body: { name: "Sunrise Homes", industry: "re", phone: "+919876543210" } });
    await startTrial({ name: "Sunrise Homes", industry: "re", phone: undefined });
    const body = (apiFetch.mock.calls.at(-1)?.[1] as { body: Record<string, unknown> }).body;
    expect(JSON.parse(JSON.stringify(body))).toEqual({ name: "Sunrise Homes", industry: "re" });
  });

  it.each([
    [409, { status: "phone_used", message: "This WhatsApp number has already had a free trial, so we can't start another. Contact us to start on a paid plan." }],
    [422, { status: "invalid", fields: { phone: "Enter the number with country code, like +919840012345" } }],
    [409, { status: "has_business" }],
    [422, { status: "unavailable" }],
    [422, { status: "invalid", fields: { name: "Enter your business name" } }],
    [500, { status: "failed", message: "We couldn't set up your trial. Try again in a moment." }],
  ])("passes the API's %i answer through as the result", async (status, body) => {
    apiFetch.mockResolvedValue(Response.json(body, { status }));
    expect(await startTrial({ name: "Sunrise Homes", industry: "re" })).toEqual(body);
  });

  it("turns a 401 into a failed result with the API's message", async () => {
    apiFetch.mockResolvedValue(Response.json({ error: { code: "unauthenticated", message: "Your session has ended. Sign in again." } }, { status: 401 }));
    expect(await startTrial({ name: "Sunrise Homes", industry: "re" })).toEqual({ status: "failed", message: "Your session has ended. Sign in again." });
  });

  it("turns a network failure or a non-JSON answer into a failed result with a safe message", async () => {
    apiFetch.mockRejectedValue(new TypeError("fetch failed"));
    expect(await startTrial({ name: "Sunrise Homes", industry: "re" })).toMatchObject({ status: "failed", message: expect.stringContaining("couldn't reach Spark Agent") });

    apiFetch.mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await startTrial({ name: "Sunrise Homes", industry: "re" })).toEqual({ status: "failed", message: "Something went wrong. Try again in a moment." });
  });
});

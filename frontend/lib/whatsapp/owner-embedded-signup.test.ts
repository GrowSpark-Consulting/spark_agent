import { describe, expect, it, vi } from "vitest";

// Stubs for Meta's SDK (runSignup), the business lookup and the API. Nothing here talks to Facebook or the API: these tests show what the
// wizard does with each outcome, not that a real Meta connection works.
const apiFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const { connectOwnerWithFacebook, createOwnerSignup, sendOwnerSignup } = await import("./owner-embedded-signup");
type Deps = import("./owner-embedded-signup").OwnerSignupDeps;
type Outcome = Awaited<ReturnType<Deps["runSignup"]>>;

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const OTHER = "b0000000-0000-4000-8000-00000000000b";
const PAYLOAD = { code: "AQD-e2e-code", wabaId: "100000000000001", phoneNumberId: "200000000000001", coexistence: false };
const CONNECTION = {
  id: "c0000000-0000-4000-8000-0000000000c1", tenant_id: TENANT, method: "embedded_signup", waba_id: PAYLOAD.wabaId,
  phone_number_id: PAYLOAD.phoneNumberId, display_phone: "+91 98765 43210", verified_name: "Skyline Homes", coexistence: false, status: "active",
  last_check: {}, quality_rating: null, messaging_limit: null, created_at: "2026-10-13T09:00:00Z",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (status: number, code: string, message: string, fields?: Record<string, string>) => json(status, { error: { code, message, ...(fields && { fields }) } });

function deps(over: { outcome?: Outcome | (() => Promise<Outcome>); tenant?: Awaited<ReturnType<Deps["resolveTenant"]>>; answer?: Response | (() => Promise<Response>) } = {}) {
  const runSignup = vi.fn(async () => (typeof over.outcome === "function" ? over.outcome() : (over.outcome ?? { status: "finished" as const, payload: PAYLOAD })));
  const resolveTenant = vi.fn(async () => over.tenant ?? { state: "ready" as const, tenantId: TENANT });
  const send = vi.fn(async () => (typeof over.answer === "function" ? over.answer() : (over.answer ?? json(201, CONNECTION))));
  return { runSignup, resolveTenant, send } satisfies Deps;
}
const run = (d: Deps, coexistence = false) => connectOwnerWithFacebook({ coexistence, tenantId: TENANT }, d);

describe("connectOwnerWithFacebook", () => {
  it("starts Meta's flow with the chosen coexistence answer, then sends exactly the documented body for this business", async () => {
    const d = deps();
    const result = await run(d, true);
    expect(d.runSignup).toHaveBeenCalledWith({ coexistence: true });
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledWith({ code: "AQD-e2e-code", wabaId: "100000000000001", phoneNumberId: "200000000000001", coexistence: false }, TENANT);
    const [body] = d.send.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(Object.keys(body).sort()).toEqual(["code", "coexistence", "phoneNumberId", "wabaId"]);
    expect(body).not.toHaveProperty("connectToken");
    expect(body).not.toHaveProperty("tenantId");
    expect(result).toEqual({ state: "connected", connection: CONNECTION });
  });

  it("reads the business only after Meta's window, so the popup opens on the click", async () => {
    const order: string[] = [];
    const d = deps();
    d.runSignup.mockImplementation(async () => (order.push("popup"), { status: "finished" as const, payload: PAYLOAD }));
    d.resolveTenant.mockImplementation(async () => (order.push("business"), { state: "ready" as const, tenantId: TENANT }));
    await run(d);
    expect(order).toEqual(["popup", "business"]);
  });

  it("a saved connection that is not active is returned as it is, for the screen to say it isn't connected", async () => {
    const d = deps({ answer: json(201, { ...CONNECTION, status: "failed" }) });
    const result = await run(d);
    expect(result).toMatchObject({ state: "connected", connection: { status: "failed" } });
  });

  it("a closed window is a cancellation, with Meta's step, and sends nothing", async () => {
    const d = deps({ outcome: { status: "cancelled", step: "Choose your business portfolio" } });
    expect(await run(d)).toEqual({ state: "cancelled", step: "Choose your business portfolio" });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.resolveTenant).not.toHaveBeenCalled();
  });

  it("no Meta app configured here: says so, sends nothing", async () => {
    const d = deps({ outcome: { status: "unavailable", problems: ["NEXT_PUBLIC_META_APP_ID is not set"] } });
    expect(await run(d)).toEqual({ state: "not_configured" });
    expect(d.send).not.toHaveBeenCalled();
  });

  it.each([
    ["error", "meta_error"],
    ["incomplete", "incomplete"],
  ] as const)("a Meta %s is a retryable failure and sends nothing", async (reason, problem) => {
    const d = deps({ outcome: { status: "failed", reason, errorCode: null } });
    expect(await run(d)).toMatchObject({ state: "failed", problem, retryable: true });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("Facebook's script failing to load is a retryable failure", async () => {
    const d = deps({ outcome: () => Promise.reject(new Error("script")) });
    expect(await run(d)).toMatchObject({ state: "failed", problem: "script", retryable: true });
  });

  it("a finish with no phone number sends nothing and says to pick one", async () => {
    const d = deps({ outcome: { status: "finished", payload: { ...PAYLOAD, phoneNumberId: null, coexistence: true } } });
    expect(await run(d)).toMatchObject({ state: "failed", problem: "no_number", retryable: true, message: expect.stringContaining("Pick or add a phone number") });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("a business that can't be worked out, or isn't the one the step opened for, sends nothing", async () => {
    const lost = deps({ tenant: { state: "error", message: "Your session has ended. Sign in again.", retryable: false } });
    expect(await run(lost)).toMatchObject({ state: "failed", problem: "business", message: "Your session has ended. Sign in again.", retryable: false });
    expect(lost.send).not.toHaveBeenCalled();
    const moved = deps({ tenant: { state: "ready", tenantId: OTHER } });
    expect(await run(moved)).toMatchObject({ state: "failed", problem: "business", retryable: false });
    expect(moved.send).not.toHaveBeenCalled();
  });

  it("501 not_available (EMBEDDED_SIGNUP_ENABLED off) is its own state, never connected", async () => {
    const d = deps({ answer: apiError(501, "not_available", "Connecting WhatsApp with Facebook isn't available yet. Ask us to connect your number instead.") });
    expect(await run(d)).toEqual({ state: "not_available", message: "Connecting WhatsApp with Facebook isn't available yet. Ask us to connect your number instead." });
  });

  it("validation_failed shows the field's reason and can be retried", async () => {
    const d = deps({ answer: apiError(422, "validation_failed", "Some details need fixing.", { phoneNumberId: "That phone number is not in the WhatsApp account you signed in with." }) });
    expect(await run(d)).toEqual({
      state: "failed",
      problem: "refused",
      message: "That phone number is not in the WhatsApp account you signed in with.",
      retryable: true,
      code: "validation_failed",
    });
  });

  it.each([
    [409, "conflict", "This phone number is already connected.", true],
    [502, "upstream_failed", "Facebook didn't accept that sign-in. Start the Facebook sign-in again.", true],
    [403, "forbidden", "Only an owner or admin can connect WhatsApp.", false],
    [401, "unauthenticated", "Sign in again.", false],
  ] as const)("%i %s is a failure with the API's message (retryable: %s), never connected", async (status, code, message, retryable) => {
    const d = deps({ answer: apiError(status, code, message) });
    expect(await run(d)).toEqual({ state: "failed", problem: "refused", message, retryable, code });
  });

  it("a network failure is retryable and claims nothing", async () => {
    const d = deps({ answer: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(await run(d)).toMatchObject({ state: "failed", problem: "network", retryable: true, code: "network" });
  });

  it("a 2xx that is not a connection, or not JSON, is unconfirmed and not retryable (the API may have saved it)", async () => {
    for (const answer of [json(201, { id: "x", status: "active" }), new Response("<html>proxy</html>", { status: 200 })]) {
      expect(await run(deps({ answer }))).toMatchObject({ state: "failed", problem: "unconfirmed", retryable: false });
    }
  });

  it("an error body that is not our envelope still becomes a plain failure", async () => {
    expect(await run(deps({ answer: new Response("Bad gateway", { status: 502 }) }))).toMatchObject({ state: "failed", problem: "refused" });
  });
});

describe("createOwnerSignup", () => {
  it("a second start while one is open opens nothing and returns null", async () => {
    let finish!: (o: Outcome) => void;
    const d = deps({ outcome: () => new Promise<Outcome>((resolve) => (finish = resolve)) });
    const signup = createOwnerSignup(d);
    const first = signup.start({ coexistence: false, tenantId: TENANT });
    const second = signup.start({ coexistence: false, tenantId: TENANT });
    const third = signup.start({ coexistence: true, tenantId: TENANT });
    expect(await second).toBeNull();
    expect(await third).toBeNull();
    finish({ status: "finished", payload: PAYLOAD });
    expect((await first)?.state).toBe("connected");
    expect(d.runSignup).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("can start again once a run has ended, including after a failure", async () => {
    const d = deps({ answer: apiError(502, "upstream_failed", "Start again.") });
    const signup = createOwnerSignup(d);
    expect((await signup.start({ coexistence: false, tenantId: TENANT }))?.state).toBe("failed");
    expect((await signup.start({ coexistence: false, tenantId: TENANT }))?.state).toBe("failed");
    expect(d.runSignup).toHaveBeenCalledTimes(2);
  });
});

describe("sendOwnerSignup", () => {
  it("POSTs the body to the Embedded Signup route for the business, as the signed-in user", async () => {
    apiFetch.mockResolvedValue(json(201, CONNECTION));
    await sendOwnerSignup(PAYLOAD as never, TENANT);
    expect(apiFetch).toHaveBeenCalledWith("/api/onboarding/whatsapp/embedded-signup", { method: "POST", body: PAYLOAD, tenantId: TENANT });
    const options = apiFetch.mock.calls[0][1] as Record<string, unknown>;
    expect(options).not.toHaveProperty("anonymous");
  });
});

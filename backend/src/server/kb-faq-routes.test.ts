import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";
import { errorOf } from "../test-support/http";

// The FAQ and gap routes: how they are wired (who may call, which tenant, which status, which id comes from the
// path). What the services do is tested in kb/faqs.test.ts.

const createFaq = vi.fn();
const updateFaq = vi.fn();
const deleteFaq = vi.fn();
const listGaps = vi.fn();
const answerGap = vi.fn();
const dismissGap = vi.fn();
vi.mock("../kb/faqs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../kb/faqs")>()),
  createFaq: (...args: unknown[]) => createFaq(...args),
  updateFaq: (...args: unknown[]) => updateFaq(...args),
  deleteFaq: (...args: unknown[]) => deleteFaq(...args),
  listGaps: (...args: unknown[]) => listGaps(...args),
  answerGap: (...args: unknown[]) => answerGap(...args),
  dismissGap: (...args: unknown[]) => dismissGap(...args),
}));
const auditQuietly = vi.fn();
vi.mock("../lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/audit")>()),
  auditQuietly: (...args: unknown[]) => auditQuietly(...args),
}));

const { createApp } = await import("./app");
const { AppError } = await import("../lib/errors");

const FRONTEND = "https://app.pakkaagent.in";
const REALTY = "10000000-0000-0000-0000-000000000001";
const SALON = "10000000-0000-0000-0000-000000000002";
const tenantRow = (id: string, name: string) => ({ id, name, vertical: "real-estate", timezone: "Asia/Kolkata", status: "trial", plan_key: "trial", trial_ends_at: null });
const member = (id: string, name: string, role: string) => ({ tenant_id: id, role, tenants: tenantRow(id, name) });

const ACCOUNTS: Record<string, { email: string; memberships: unknown[] }> = {
  "owner.token.sig": { email: "owner@test.local", memberships: [member(REALTY, "Test Realty", "owner")] },
  "multi.token.sig": { email: "multi@test.local", memberships: [member(REALTY, "Test Realty", "owner"), member(SALON, "Beta Salon", "admin")] },
};

function fakeUserClient(token: string): SupabaseClient {
  const account = ACCOUNTS[token];
  const { client } = fakeSupabase({ memberships: { data: account?.memberships ?? [], error: null } });
  const getUser = async (jwt: string) => {
    const known = ACCOUNTS[jwt];
    return known
      ? { data: { user: { id: `user-${known.email}`, email: known.email } }, error: null }
      : { data: { user: null }, error: { __isAuthError: true, name: "AuthApiError", status: 401, message: "invalid JWT" } };
  };
  return Object.assign(client, { auth: { getUser } });
}

const app = createApp({ userClient: fakeUserClient, inngest: async () => Response.json({}), allowedOrigins: new Set([FRONTEND]) });
const as = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, origin: FRONTEND, ...extra });
const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app(new Request(`http://localhost:4000${path}`, { method, headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }));

const FAQ = "f0000000-0000-0000-0000-0000000000f1";
const GAP = "a0000000-0000-0000-0000-0000000000a1";

beforeEach(() => {
  for (const mock of [createFaq, updateFaq, deleteFaq, listGaps, answerGap, dismissGap, auditQuietly]) mock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/kb/faqs", () => {
  it("answers 201 with the FAQ, for the signed-in member's business, handing the service the body", async () => {
    createFaq.mockResolvedValue({ id: FAQ, q: "Parking?", a: "Yes" });
    const res = await call("POST", "/api/kb/faqs", as("owner.token.sig"), { q: "Parking?", a: "Yes" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: FAQ, q: "Parking?", a: "Yes" });
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(createFaq).toHaveBeenCalledWith(expect.objectContaining({ role: "owner", tenant: expect.objectContaining({ id: REALTY }) }), { q: "Parking?", a: "Yes" });
  });

  it("takes the business from X-Pakka-Tenant only if it is one of the caller's own", async () => {
    createFaq.mockResolvedValue({ id: FAQ, q: "Q", a: "A" });
    await call("POST", "/api/kb/faqs", as("multi.token.sig", { "x-pakka-tenant": SALON }), { q: "Q", a: "A" });
    expect(createFaq.mock.calls[0][0].tenant.id).toBe(SALON);
    createFaq.mockClear();
    await call("POST", "/api/kb/faqs", as("owner.token.sig", { "x-pakka-tenant": SALON }), { q: "Q", a: "A" });
    expect(createFaq.mock.calls[0][0].tenant.id).toBe(REALTY);
  });

  it("needs a signed-in member and refuses another origin, without running the service", async () => {
    expect((await call("POST", "/api/kb/faqs", { origin: FRONTEND }, { q: "Q", a: "A" })).status).toBe(401);
    expect((await call("POST", "/api/kb/faqs", { authorization: "Bearer owner.token.sig", origin: "https://evil.example" }, { q: "Q", a: "A" })).status).toBe(403);
    expect(createFaq).not.toHaveBeenCalled();
  });

  it("answers a body that is not JSON as validation_failed, before the service", async () => {
    const res = await app(new Request("http://localhost:4000/api/kb/faqs", { method: "POST", headers: as("owner.token.sig"), body: "not json" }));
    expect(res.status).toBe(422);
    expect(createFaq).not.toHaveBeenCalled();
  });

  it.each([
    ["conflict", 409],
    ["upstream_failed", 502],
    ["forbidden", 403],
  ] as const)("turns the service's %s into the envelope with status %s", async (code, status) => {
    createFaq.mockRejectedValue(new AppError(code, "Words for the owner."));
    const res = await call("POST", "/api/kb/faqs", as("owner.token.sig"), { q: "Q", a: "A" });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toEqual({ code, message: "Words for the owner." });
  });

  it("carries the field errors the frontend shows", async () => {
    createFaq.mockRejectedValue(new AppError("validation_failed", "Check.", { q: "Write the question." }));
    const res = await call("POST", "/api/kb/faqs", as("owner.token.sig"), { q: "", a: "A" });
    expect((await errorOf(res)).fields).toEqual({ q: "Write the question." });
  });

  it("answers an unexpected failure with a generic message", async () => {
    createFaq.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5"));
    const res = await call("POST", "/api/kb/faqs", as("owner.token.sig"), { q: "Q", a: "A" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.5");
  });
});

describe("PATCH and DELETE /api/kb/faqs/:id", () => {
  it("PATCH answers 200 with the FAQ, with the id from the path and the body", async () => {
    updateFaq.mockResolvedValue({ id: FAQ, q: "Q", a: "New" });
    const res = await call("PATCH", `/api/kb/faqs/${FAQ}`, as("owner.token.sig"), { a: "New" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: FAQ, q: "Q", a: "New" });
    expect(updateFaq).toHaveBeenCalledWith(expect.objectContaining({ tenant: expect.objectContaining({ id: REALTY }) }), FAQ, { a: "New" });
  });

  it("DELETE answers 204 with no body, with the id from the path", async () => {
    deleteFaq.mockResolvedValue(undefined);
    const res = await call("DELETE", `/api/kb/faqs/${FAQ}`, as("owner.token.sig"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(deleteFaq).toHaveBeenCalledWith(expect.objectContaining({ tenant: expect.objectContaining({ id: REALTY }) }), FAQ);
  });

  it("answers not_found in the envelope", async () => {
    deleteFaq.mockRejectedValue(new AppError("not_found", "That question was not found."));
    const res = await call("DELETE", `/api/kb/faqs/${FAQ}`, as("owner.token.sig"));
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
  });

  it("needs a signed-in member", async () => {
    expect((await call("DELETE", `/api/kb/faqs/${FAQ}`, { origin: FRONTEND })).status).toBe(401);
    expect((await call("PATCH", `/api/kb/faqs/${FAQ}`, { origin: FRONTEND }, { a: "x" })).status).toBe(401);
    expect(deleteFaq).not.toHaveBeenCalled();
    expect(updateFaq).not.toHaveBeenCalled();
  });

  it("allows the browser's preflight for PATCH and DELETE, and refuses GET", async () => {
    for (const method of ["PATCH", "DELETE"]) {
      const pre = await app(new Request(`http://localhost:4000/api/kb/faqs/${FAQ}`, { method: "OPTIONS", headers: { origin: FRONTEND, "access-control-request-method": method, "access-control-request-headers": "authorization,x-pakka-tenant,content-type" } }));
      expect(pre.headers.get("access-control-allow-methods")).toContain(method);
    }
    expect((await call("GET", `/api/kb/faqs/${FAQ}`, as("owner.token.sig"))).status).toBe(405);
  });
});

describe("GET /api/kb/gaps", () => {
  it("answers the list for the member's business", async () => {
    const gaps = [{ id: GAP, question: "Home visits?", askedCount: 4, lastAskedBy: "Priya" }];
    listGaps.mockResolvedValue(gaps);
    const res = await call("GET", "/api/kb/gaps", as("owner.token.sig"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(gaps);
    expect(listGaps).toHaveBeenCalledWith(expect.objectContaining({ tenant: expect.objectContaining({ id: REALTY }) }));
  });

  it("needs a signed-in member, and refuses POST", async () => {
    expect((await call("GET", "/api/kb/gaps", { origin: FRONTEND })).status).toBe(401);
    expect((await call("POST", "/api/kb/gaps", as("owner.token.sig"), {})).status).toBe(405);
    expect(listGaps).not.toHaveBeenCalled();
  });
});

describe("POST /api/kb/gaps/:id/answer and /dismiss", () => {
  it("answer: 200 with { faq }, with the id from the path and the body", async () => {
    answerGap.mockResolvedValue({ faq: { id: FAQ, q: "Home visits?", a: "Yes" } });
    const res = await call("POST", `/api/kb/gaps/${GAP}/answer`, as("owner.token.sig"), { a: "Yes" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ faq: { id: FAQ, q: "Home visits?", a: "Yes" } });
    expect(answerGap).toHaveBeenCalledWith(expect.objectContaining({ tenant: expect.objectContaining({ id: REALTY }) }), GAP, { a: "Yes" });
  });

  it("answer: conflict and not_found reach the browser in the envelope", async () => {
    answerGap.mockRejectedValueOnce(new AppError("conflict", "This question was already answered."));
    expect((await call("POST", `/api/kb/gaps/${GAP}/answer`, as("owner.token.sig"), { a: "x" })).status).toBe(409);
    answerGap.mockRejectedValueOnce(new AppError("not_found", "That question was not found."));
    expect((await call("POST", `/api/kb/gaps/${GAP}/answer`, as("owner.token.sig"), { a: "x" })).status).toBe(404);
  });

  it("dismiss: 204 with no body, and no body needed", async () => {
    dismissGap.mockResolvedValue(undefined);
    const res = await call("POST", `/api/kb/gaps/${GAP}/dismiss`, as("owner.token.sig"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(dismissGap).toHaveBeenCalledWith(expect.objectContaining({ tenant: expect.objectContaining({ id: REALTY }) }), GAP);
  });

  it("both need a signed-in member", async () => {
    expect((await call("POST", `/api/kb/gaps/${GAP}/answer`, { origin: FRONTEND }, { a: "x" })).status).toBe(401);
    expect((await call("POST", `/api/kb/gaps/${GAP}/dismiss`, { origin: FRONTEND })).status).toBe(401);
    expect(answerGap).not.toHaveBeenCalled();
    expect(dismissGap).not.toHaveBeenCalled();
  });
});

describe("audit: each change to the knowledge base names the member who made it", () => {
  const OWNER = "user-owner@test.local";
  const audited = () => auditQuietly.mock.calls.map(([entry]) => entry);

  it("a new, edited or removed FAQ", async () => {
    createFaq.mockResolvedValue({ id: FAQ, q: "Q", a: "A" });
    updateFaq.mockResolvedValue({ id: FAQ, q: "Q", a: "B" });
    deleteFaq.mockResolvedValue(undefined);
    await call("POST", "/api/kb/faqs", as("owner.token.sig"), { q: "Q", a: "A" });
    await call("PATCH", `/api/kb/faqs/${FAQ}`, as("owner.token.sig"), { a: "B" });
    await call("DELETE", `/api/kb/faqs/${FAQ}`, as("owner.token.sig"));
    expect(audited()).toEqual([
      { tenantId: REALTY, actor: OWNER, action: "kb.faq_created", entity: "kb_faq", entityId: FAQ },
      { tenantId: REALTY, actor: OWNER, action: "kb.faq_updated", entity: "kb_faq", entityId: FAQ },
      { tenantId: REALTY, actor: OWNER, action: "kb.faq_deleted", entity: "kb_faq", entityId: FAQ },
    ]);
  });

  it("an answered gap (with the FAQ it became) and a dismissed one, in the business the member picked", async () => {
    answerGap.mockResolvedValue({ faq: { id: FAQ, q: "Home visits?", a: "Yes" } });
    dismissGap.mockResolvedValue(undefined);
    await call("POST", `/api/kb/gaps/${GAP}/answer`, as("owner.token.sig"), { a: "Yes" });
    await call("POST", `/api/kb/gaps/${GAP}/dismiss`, as("multi.token.sig", { "x-pakka-tenant": SALON }));
    expect(audited()).toEqual([
      { tenantId: REALTY, actor: OWNER, action: "kb.gap_answered", entity: "kb_gap", entityId: GAP, diff: { faqId: FAQ } },
      { tenantId: SALON, actor: "user-multi@test.local", action: "kb.gap_dismissed", entity: "kb_gap", entityId: GAP },
    ]);
  });

  it("nothing for a change that did not happen", async () => {
    createFaq.mockRejectedValue(new AppError("conflict", "Already there."));
    deleteFaq.mockRejectedValue(new AppError("not_found", "Not found."));
    answerGap.mockRejectedValue(new AppError("conflict", "Already answered."));
    await call("POST", "/api/kb/faqs", as("owner.token.sig"), { q: "Q", a: "A" });
    await call("DELETE", `/api/kb/faqs/${FAQ}`, as("owner.token.sig"));
    await call("POST", `/api/kb/gaps/${GAP}/answer`, as("owner.token.sig"), { a: "x" });
    await call("POST", "/api/kb/faqs", { origin: FRONTEND }, { q: "Q", a: "A" });
    expect(auditQuietly).not.toHaveBeenCalled();
  });
});

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/browser", () => ({ getSupabaseBrowserClient: () => ({}) }));

const { resolveBrowserTenant } = await import("./tenant");

const USER = { id: "u0000000-0000-4000-8000-000000000001", email: "owner@example.test" };
const T1 = "a0000000-0000-4000-8000-00000000000a";
const T2 = "b0000000-0000-4000-8000-00000000000b";

const tenantRow = (id: string, name: string) => ({
  id, name, vertical: "any-pack", timezone: "Asia/Kolkata", status: "trial", plan_key: "trial", trial_ends_at: "2026-10-30T00:00:00Z",
});
const membership = (id: string, name: string, role = "owner") => ({ tenant_id: id, role, tenants: tenantRow(id, name) });

/** The part of the Supabase client resolveTenant uses: the session, and memberships read for one user. */
function fakeClient(opts: { session?: { user: typeof USER } | null; rows?: unknown[]; error?: unknown }) {
  const reads: { table: string; userId: unknown }[] = [];
  const client = {
    auth: { getSession: () => Promise.resolve({ data: { session: opts.session === undefined ? { user: USER } : opts.session } }) },
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, userId: unknown) => {
          reads.push({ table, userId });
          return { returns: () => Promise.resolve({ data: opts.rows ?? [], error: opts.error ?? null }) };
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { client, reads };
}

describe("resolveBrowserTenant", () => {
  it("returns the one business the signed-in user belongs to, read as that user", async () => {
    const { client, reads } = fakeClient({ rows: [membership(T1, "Skyline Homes", "admin")] });
    expect(await resolveBrowserTenant(client)).toEqual({ status: "ok", tenantId: T1, role: "admin" });
    expect(reads).toEqual([{ table: "memberships", userId: USER.id }]);
  });

  it("will not pick between several businesses: the caller has to send nothing", async () => {
    const { client } = fakeClient({ rows: [membership(T2, "Beta"), membership(T1, "Alpha")] });
    const result = await resolveBrowserTenant(client);
    expect(result).toEqual({
      status: "choose",
      businesses: [
        { tenantId: T1, name: "Alpha" },
        { tenantId: T2, name: "Beta" },
      ],
    });
  });

  it("says there is no business for an account with none, or whose businesses RLS hides", async () => {
    expect(await resolveBrowserTenant(fakeClient({ rows: [] }).client)).toEqual({ status: "no_business" });
    expect(await resolveBrowserTenant(fakeClient({ rows: [{ tenant_id: T1, role: "owner", tenants: null }] }).client)).toEqual({ status: "no_business" });
  });

  it("says signed out when there is no session, without reading anything", async () => {
    const { client, reads } = fakeClient({ session: null });
    expect(await resolveBrowserTenant(client)).toEqual({ status: "signed_out" });
    expect(reads).toEqual([]);
  });

  it("answers error, never a guess, when the read fails or the session cannot be read", async () => {
    expect(await resolveBrowserTenant(fakeClient({ error: { message: "boom" } }).client)).toEqual({ status: "error" });
    const broken = { auth: { getSession: () => Promise.reject(new TypeError("fetch failed")) } } as unknown as SupabaseClient;
    expect(await resolveBrowserTenant(broken)).toEqual({ status: "error" });
  });

  it("reads again on every call, so a business that changed is picked up", async () => {
    let rows = [membership(T1, "Alpha")];
    const client = {
      auth: { getSession: () => Promise.resolve({ data: { session: { user: USER } } }) },
      from: () => ({ select: () => ({ eq: () => ({ returns: () => Promise.resolve({ data: rows, error: null }) }) }) }),
    } as unknown as SupabaseClient;
    expect(await resolveBrowserTenant(client)).toMatchObject({ status: "ok", tenantId: T1 });
    rows = [membership(T2, "Beta")];
    expect(await resolveBrowserTenant(client)).toMatchObject({ status: "ok", tenantId: T2 });
  });
});

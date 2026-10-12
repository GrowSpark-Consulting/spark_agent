import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { fetchTemplates, languageName, summarizeTemplates, summaryLine } from "./templates";

const TENANT = "10000000-0000-0000-0000-000000000004";
const OTHER = "10000000-0000-0000-0000-000000000005";
const CONNECTION = "30000000-0000-0000-0000-000000000001";
const row = (over: Record<string, unknown> = {}) => ({
  id: "70000000-0000-0000-0000-000000000001",
  tenant_id: TENANT,
  connection_id: CONNECTION,
  name: "reminder_24h_v1",
  language: "en",
  category: "utility",
  status: "approved",
  rejection_reason: null,
  ...over,
});

function client(result: { data: unknown; error: unknown }) {
  const order = vi.fn().mockResolvedValue(result);
  const eq = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from } as unknown as SupabaseClient, from, select, eq, order };
}

describe("fetchTemplates", () => {
  it("reads whatsapp_templates for this business and maps the rows", async () => {
    const c = client({ data: [row(), row({ id: "70000000-0000-0000-0000-000000000002", name: "reminder_24h_v1", language: "ta", status: "rejected", rejection_reason: " Variables look wrong " })], error: null });
    const rows = await fetchTemplates(c.client, TENANT);
    expect(c.from).toHaveBeenCalledWith("whatsapp_templates");
    expect(c.eq).toHaveBeenCalledWith("tenant_id", TENANT);
    expect(rows.map((r) => [r.language, r.status, r.rejectionReason])).toEqual([
      ["en", "approved", null],
      ["ta", "rejected", "Variables look wrong"],
    ]);
  });

  it("drops a row for another business even if one gets through", async () => {
    const rows = await fetchTemplates(client({ data: [row(), row({ id: "70000000-0000-0000-0000-000000000003", tenant_id: OTHER })], error: null }).client, TENANT);
    expect(rows).toHaveLength(1);
  });

  it("fails the whole read on a status outside the table's check, instead of showing it", async () => {
    await expect(fetchTemplates(client({ data: [row({ status: "live" })], error: null }).client, TENANT)).rejects.toThrow("unexpected shape");
  });

  it("throws the database's error", async () => {
    const error = { code: "42501", message: "denied" };
    await expect(fetchTemplates(client({ data: null, error }).client, TENANT)).rejects.toBe(error);
  });
});

describe("summaries", () => {
  it("counts each status and says only what is stored", () => {
    const s = summarizeTemplates([{ status: "approved" }, { status: "approved" }, { status: "pending" }, { status: "rejected" }]);
    expect(s.total).toBe(4);
    expect(summaryLine(s)).toBe("2 approved, 1 waiting for Meta, 1 rejected.");
  });

  it("says nothing was submitted when there are none", () => {
    expect(summaryLine(summarizeTemplates([]))).toBe("No templates have been submitted for this number yet.");
  });

  it("names languages and leaves unknown codes as they are", () => {
    expect(languageName("ta")).toBe("Tamil");
    expect(languageName("EN")).toBe("English");
    expect(languageName("xx")).toBe("xx");
  });
});

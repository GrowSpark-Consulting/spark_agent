import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  fetchLeadCounts,
  fetchLeadsPage,
  fetchStageCounts,
  LeadDataError,
  NO_LEAD_FILTERS,
  STAGES,
  type LeadFilters,
} from "./data";

// Filters and counts that are worked out by the database over the whole business, not over the leads on screen. A fake client
// records every call of every query, so these show exactly what is asked: which business, which clauses, whether only a count.

const TENANT = "c0000000-0000-0000-0000-00000000000a";
const OTHER = "c0000000-0000-0000-0000-00000000000b";
const id = (n: number) => `d0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

type Call = [string, unknown[]];
type Answer = { data?: unknown; count?: number | null; error?: unknown };

function fakeClient(respond: (calls: Call[]) => Answer = () => ({ data: [] })) {
  const queries: Call[][] = [];
  const client = {
    from: (table: string) => {
      const calls: Call[] = [["from", [table]]];
      queries.push(calls);
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "is", "gte", "not", "or", "order", "limit"]) {
        builder[name] = (...args: unknown[]) => {
          calls.push([name, args]);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, count: null, error: null, ...respond(calls) }).then(resolve);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

const has = (calls: Call[], name: string, ...args: unknown[]) => calls.some(([n, a]) => n === name && JSON.stringify(a) === JSON.stringify(args));
const names = (calls: Call[]) => calls.map(([n]) => n);

const leadRow = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  tenant_id: TENANT,
  contact_id: id(1000 + n),
  stage: "new",
  score: null,
  temperature: null,
  fields: {},
  owner_user_id: null,
  created_at: "2026-10-10T10:00:00.123456+00:00",
  updated_at: `2026-10-11T10:${String(59 - (n % 60)).padStart(2, "0")}:00.123456+00:00`,
  contacts: { name: `Lead ${n}`, phone: "+919812345621" },
  ...over,
});
const filters = (over: Partial<LeadFilters> = {}): LeadFilters => ({ ...NO_LEAD_FILTERS, ...over });

describe("a page of leads, filtered by the database", () => {
  it("asks for the business's leads only, with no filter clause when nothing is filtered", async () => {
    const { client, queries } = fakeClient();
    await fetchLeadsPage(client, TENANT);
    expect(has(queries[0], "eq", "tenant_id", TENANT)).toBe(true);
    expect(names(queries[0])).not.toContain("is");
    expect(names(queries[0])).not.toContain("gte");
    expect(queries[0].filter(([n, a]) => n === "eq" && a[0] === "temperature")).toEqual([]);
  });

  it("filters by temperature on the server", async () => {
    for (const t of ["hot", "warm", "cold", "disqualified"] as const) {
      const { client, queries } = fakeClient();
      await fetchLeadsPage(client, TENANT, null, 200, filters({ temperature: t }));
      expect(has(queries[0], "eq", "temperature", t)).toBe(true);
    }
  });

  it("reads not scored as no temperature", async () => {
    const { client, queries } = fakeClient();
    await fetchLeadsPage(client, TENANT, null, 200, filters({ temperature: "unscored" }));
    expect(has(queries[0], "is", "temperature", null)).toBe(true);
  });

  it("filters by a minimum score on the server, which leaves out unscored leads", async () => {
    const { client, queries } = fakeClient();
    await fetchLeadsPage(client, TENANT, null, 200, filters({ minScore: 70 }));
    expect(has(queries[0], "gte", "score", 70)).toBe(true);
  });

  it("combines both filters, and keeps paging by value underneath them", async () => {
    const { client, queries } = fakeClient();
    const cursor = { updatedAt: "2026-10-11T10:00:00.123456+00:00", id: id(5) };
    await fetchLeadsPage(client, TENANT, cursor, 200, filters({ temperature: "hot", minScore: 80 }));
    expect(has(queries[0], "eq", "temperature", "hot")).toBe(true);
    expect(has(queries[0], "gte", "score", 80)).toBe(true);
    expect(queries[0].some(([n]) => n === "or")).toBe(true);
    expect(has(queries[0], "order", "updated_at", { ascending: false })).toBe(true);
  });

  it("asks for the exact number of matching leads on the first page only", async () => {
    const first = fakeClient(() => ({ data: [leadRow(1)], count: 1234 }));
    const page = await fetchLeadsPage(first.client, TENANT, null, 200, filters({ temperature: "hot" }));
    expect(first.queries[0].find(([n]) => n === "select")?.[1][1]).toEqual({ count: "exact" });
    expect(page.total).toBe(1234);

    const later = fakeClient(() => ({ data: [leadRow(1)], count: 1234 }));
    const next = await fetchLeadsPage(later.client, TENANT, { updatedAt: "2026-10-11T10:00:00.123456+00:00", id: id(5) });
    expect(later.queries[0].find(([n]) => n === "select")?.[1][1]).toBeUndefined();
    expect(next.total).toBeNull();
  });

  it("says the total is unknown when the answer carries none, instead of making one up", async () => {
    const { client } = fakeClient(() => ({ data: [leadRow(1)], count: null }));
    expect((await fetchLeadsPage(client, TENANT)).total).toBeNull();
    const odd = fakeClient(() => ({ data: [leadRow(1)], count: -1 }));
    expect((await fetchLeadsPage(odd.client, TENANT)).total).toBeNull();
  });

  it("still drops a row of another business that arrives, and passes errors on", async () => {
    const { client } = fakeClient(() => ({ data: [leadRow(1), leadRow(2, { tenant_id: OTHER })], count: 2 }));
    expect((await fetchLeadsPage(client, TENANT)).leads.map((l) => l.id)).toEqual([id(1)]);
    const pgError = { code: "42501", message: "permission denied", details: null, hint: null };
    await expect(fetchLeadsPage(fakeClient(() => ({ error: pgError })).client, TENANT)).rejects.toBe(pgError);
  });
});

describe("the counts for the whole business", () => {
  const byClause = (calls: Call[]): number => {
    if (has(calls, "eq", "temperature", "hot")) return 40;
    if (has(calls, "eq", "temperature", "warm")) return 30;
    if (has(calls, "eq", "temperature", "cold")) return 20;
    if (has(calls, "eq", "temperature", "disqualified")) return 5;
    if (has(calls, "is", "temperature", null)) return 7;
    if (names(calls).includes("not")) return 90;
    return -999;
  };

  it("makes six head-only counts for the business, each with its own clause, and no more", async () => {
    const { client, queries } = fakeClient((calls) => ({ count: byClause(calls) }));
    const counts = await fetchLeadCounts(client, TENANT);
    expect(queries).toHaveLength(6);
    for (const q of queries) {
      expect(has(q, "from", "leads")).toBe(true);
      expect(has(q, "eq", "tenant_id", TENANT)).toBe(true);
      expect(q.find(([n]) => n === "select")?.[1]).toEqual(["id", { count: "exact", head: true }]);
    }
    expect(counts).toEqual({ total: 102, open: 90, hot: 40, warm: 30, cold: 20, disqualified: 5, unscored: 7 });
  });

  it("counts open leads as every stage but won and lost", async () => {
    const { client, queries } = fakeClient((calls) => ({ count: byClause(calls) }));
    await fetchLeadCounts(client, TENANT);
    const open = queries.find((q) => names(q).includes("not"))!;
    expect(has(open, "not", "stage", "in", "(won,lost)")).toBe(true);
  });

  it("is the sum of the temperature buckets for All, because every lead is in exactly one", async () => {
    const { client } = fakeClient((calls) => ({ count: byClause(calls) }));
    const c = await fetchLeadCounts(client, TENANT);
    expect(c.total).toBe(c.hot + c.warm + c.cold + c.disqualified + c.unscored);
  });

  it("fails as a whole if any count fails or comes back unusable, never showing a partial set", async () => {
    const pgError = { code: "42501", message: "permission denied", details: null, hint: null };
    await expect(fetchLeadCounts(fakeClient((c) => (has(c, "eq", "temperature", "cold") ? { error: pgError } : { count: 1 })).client, TENANT)).rejects.toBe(pgError);
    for (const bad of [null, -3, 1.5, Number.NaN]) {
      await expect(fetchLeadCounts(fakeClient((c) => (has(c, "eq", "temperature", "warm") ? { count: bad } : { count: 1 })).client, TENANT)).rejects.toBeInstanceOf(LeadDataError);
    }
  });
});

describe("the counts per stage", () => {
  it("makes one head-only count per stage of the pipeline, under the same filters as the list", async () => {
    const { client, queries } = fakeClient((calls) => ({ count: STAGES.findIndex((s) => has(calls, "eq", "stage", s)) + 1 }));
    const counts = await fetchStageCounts(client, TENANT, filters({ temperature: "hot", minScore: 60 }));
    expect(queries).toHaveLength(STAGES.length);
    for (const q of queries) {
      expect(has(q, "eq", "tenant_id", TENANT)).toBe(true);
      expect(has(q, "eq", "temperature", "hot")).toBe(true);
      expect(has(q, "gte", "score", 60)).toBe(true);
      expect(q.find(([n]) => n === "select")?.[1]).toEqual(["id", { count: "exact", head: true }]);
    }
    expect(Object.keys(counts)).toEqual([...STAGES]);
    expect(counts.new).toBe(1);
    expect(counts.human).toBe(STAGES.length);
  });

  it("rejects an unusable count", async () => {
    await expect(fetchStageCounts(fakeClient(() => ({ count: null })).client, TENANT, NO_LEAD_FILTERS)).rejects.toBeInstanceOf(LeadDataError);
  });
});

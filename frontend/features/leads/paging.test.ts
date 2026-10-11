import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { FormattedError } from "@/lib/errors";
import { fetchLeadsPage, LEAD_PAGE_SIZE, LeadDataError, LeadRow, matchesFilters, temperatureCounts, toLead, type Lead, type LeadCursor, type LeadsPage } from "./data";
import { initialLeadsPaging, leadsPagingReducer, refreshLeavesGap, type LeadsPaging, type LeadsPagingAction } from "./paging";

// Reading and showing more than one page of leads. The read goes through the real fetchLeadsPage; only the database is
// replaced, by a small in-memory emulation of the PostgREST query the board sends (eq on the business, the keyset `or`,
// order and limit). It shows the paging LOGIC is right: no lead lost or repeated, whatever changes while someone browses.
// It does not show that a real PostgREST accepts the `or` filter with a timestamptz: only a read against a real Supabase
// can, and none was run (see the matrix, "Leads board beyond one page").

const TENANT = "c0000000-0000-4000-8000-00000000000a";
const OTHER = "c0000000-0000-4000-8000-00000000000b";
const CONTACT = "e0000000-0000-4000-8000-000000000001";
const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const asError = (message: string): FormattedError => ({ code: "network", title: "You're offline", message, retryable: true });

type Row = Record<string, unknown> & { id: string; tenant_id: string; updated_at: string };

/** A stored timestamp in the database's format, with microseconds: `base` seconds after a fixed start. */
const stamp = (seconds: number, micro = 0) => {
  const t = new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + seconds * 1000).toISOString().replace("Z", "").replace(/\.\d+$/, "");
  return `${t}.${String(micro).padStart(6, "0")}+00:00`;
};

const row = (n: number, over: Partial<Row> = {}): Row => ({
  id: id(n),
  tenant_id: TENANT,
  contact_id: CONTACT,
  stage: "new",
  score: null,
  temperature: null,
  fields: {},
  owner_user_id: null,
  created_at: stamp(0),
  updated_at: stamp(n),
  contacts: { name: `Lead ${n}`, phone: "+919812345621" },
  ...over,
});

/** A database holding `rows`, answering exactly the query shape fetchLeadsPage builds. */
function database(rows: Row[]) {
  const requests: { or: string | null; limit: number | null; tenant: string | null }[] = [];
  const client = {
    from: (table: string) => {
      if (table !== "leads") throw new Error(`unexpected table ${table}`);
      let tenant: string | null = null;
      let or: string | null = null;
      let limit: number | null = null;
      const order: [string, boolean][] = [];
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: string) => {
          if (column === "tenant_id") tenant = value;
          return builder;
        },
        or: (filter: string) => {
          or = filter;
          return builder;
        },
        order: (column: string, opts: { ascending: boolean }) => {
          order.push([column, opts.ascending]);
          return builder;
        },
        limit: (n: number) => {
          limit = n;
          return builder;
        },
        then: (resolve: (v: unknown) => unknown) => {
          requests.push({ or, limit, tenant });
          let out = rows.filter((r) => r.tenant_id === tenant);
          if (or) {
            const m = /^updated_at\.lt\.(.+),and\(updated_at\.eq\.(.+),id\.lt\.(.+)\)$/.exec(or);
            if (!m || m[1] !== m[2]) throw new Error(`the emulation does not understand: ${or}`);
            out = out.filter((r) => r.updated_at < m[1] || (r.updated_at === m[1] && r.id < m[3]));
          }
          // The board asks for newest first, then by id, descending both times.
          expect(order).toEqual([["updated_at", false], ["id", false]]);
          out = [...out].sort((a, b) => (a.updated_at === b.updated_at ? (a.id < b.id ? 1 : -1) : a.updated_at < b.updated_at ? 1 : -1));
          return Promise.resolve({ data: out.slice(0, limit ?? out.length), error: null }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, requests };
}

/** Reads every page the way the board does, stopping when there is no next page. */
async function readAll(client: SupabaseClient, tenant = TENANT, pageSize?: number, between?: (pageNumber: number) => void) {
  const pages: LeadsPage[] = [];
  let cursor: LeadCursor | null = null;
  for (let n = 1; n <= 100; n++) {
    const page = await fetchLeadsPage(client, tenant, cursor, pageSize);
    pages.push(page);
    between?.(n);
    if (!page.next) break;
    cursor = page.next;
  }
  return pages;
}

describe("reading more than one page", () => {
  it("reads 1,234 leads, more than the old single page of 500, with none lost and none repeated", async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => row(i + 1));
    const { client, requests } = database(rows);
    const pages = await readAll(client);
    const ids = pages.flatMap((p) => p.leads.map((l) => l.id));
    expect(ids).toHaveLength(1234);
    expect(new Set(ids).size).toBe(1234);
    expect(new Set(ids)).toEqual(new Set(rows.map((r) => r.id)));
    // Newest-updated first, across pages.
    expect(ids[0]).toBe(id(1234));
    expect(ids[1233]).toBe(id(1));
    expect(pages.map((p) => p.leads.length)).toEqual([200, 200, 200, 200, 200, 200, 34]);
    // The first read has no cursor; every later one asks for what is older than the last lead shown, and no read asks for all.
    expect(requests[0].or).toBeNull();
    expect(requests.slice(1).every((r) => r.or !== null)).toBe(true);
    expect(requests.every((r) => r.limit === LEAD_PAGE_SIZE)).toBe(true);
  });

  it("does not make a next page when the last one is exactly full of nothing: fewer than a page ends the list", async () => {
    const { client } = database(Array.from({ length: 5 }, (_, i) => row(i + 1)));
    const [only] = await readAll(client);
    expect(only.leads).toHaveLength(5);
    expect(only.next).toBeNull();
  });

  it("asks once more when the list is an exact multiple of the page size, and ends on the empty page", async () => {
    const { client } = database(Array.from({ length: 6 }, (_, i) => row(i + 1)));
    const pages = await readAll(client, TENANT, 3);
    expect(pages.map((p) => p.leads.length)).toEqual([3, 3, 0]);
    expect(pages.at(-1)?.next).toBeNull();
  });

  it("keeps leads that were updated at the same moment, on either side of a page boundary", async () => {
    // Ten leads share one timestamp, so the page boundary falls inside the tie; the id breaks it.
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, { updated_at: stamp(100, 123456) }));
    const pages = await readAll(database(rows).client, TENANT, 4);
    const ids = pages.flatMap((p) => p.leads.map((l) => l.id));
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("uses the stored timestamp exactly, microseconds included, in the next page's filter", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(i + 1, { updated_at: stamp(i + 1, 987654) }));
    const { client, requests } = database(rows);
    await readAll(client, TENANT, 3);
    expect(requests[1].or).toBe(`updated_at.lt.${stamp(4, 987654)},and(updated_at.eq.${stamp(4, 987654)},id.lt.${id(4)})`);
  });

  it("loses and repeats nothing when leads are updated or arrive while someone is paging", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1));
    const { client } = database(rows);
    const pages = await readAll(client, TENANT, 10, (pageNumber) => {
      if (pageNumber !== 1) return;
      // After the first page: an older lead (not yet read) is updated, a brand-new lead is created, and one already shown is updated.
      rows.find((r) => r.id === id(5))!.updated_at = stamp(500);
      rows.push(row(99, { updated_at: stamp(600) }));
      rows.find((r) => r.id === id(25))!.updated_at = stamp(700);
    });
    const ids = pages.flatMap((p) => p.leads.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length); // nothing repeated
    // Every lead that existed when reading began, and was not moved to the front of what is already read, is still read once.
    const missing = Array.from({ length: 30 }, (_, i) => id(i + 1)).filter((x) => !ids.includes(x));
    // Only a lead that was updated after the first page AND had not yet been read can be missed: its new position is ahead of the cursor.
    expect(missing).toEqual([id(5)]);
  });

  it("drops another business's rows even if they arrive, and reads only the session's business", async () => {
    const rows = [row(1), row(2, { tenant_id: OTHER }), row(3)];
    const { client, requests } = database(rows);
    const [page] = await readAll(client);
    expect(page.leads.map((l) => l.id)).toEqual([id(3), id(1)]);
    expect(requests.every((r) => r.tenant === TENANT)).toBe(true);
    // A row of another business that slips past the query is dropped by the parser.
    const leaky = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [row(2, { tenant_id: OTHER }), row(1)], error: null }) }) }) }) }) }) } as unknown as SupabaseClient;
    expect((await fetchLeadsPage(leaky, TENANT)).leads.map((l) => l.id)).toEqual([id(1)]);
  });

  it("will not guess a next page from a full page whose last row has no usable cursor", async () => {
    const bad = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [row(1), { ...row(2), updated_at: "" }], error: null }) }) }) }) }) }) } as unknown as SupabaseClient;
    await expect(fetchLeadsPage(bad, TENANT, null, 2)).rejects.toBeInstanceOf(LeadDataError);
  });

  it("passes a database error on, for the screen to show with Try again", async () => {
    const failing = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: new Error("boom") }) }) }) }) }) }) } as unknown as SupabaseClient;
    await expect(fetchLeadsPage(failing, TENANT)).rejects.toThrow("boom");
  });
});

const lead = (n: number, over: Record<string, unknown> = {}): Lead => toLead(LeadRow.parse(row(n, { temperature: null, ...over })));
const page = (leads: Lead[], next: LeadCursor | null): LeadsPage => ({ leads, next });
const cursor = (n: number): LeadCursor => ({ updatedAt: stamp(n), id: id(n) });
const run = (actions: LeadsPagingAction[], from: LeadsPaging = initialLeadsPaging()) => actions.reduce(leadsPagingReducer, from);

describe("the board's loading state", () => {
  const first = (generation = 1, leads = [lead(3), lead(2)], next: LeadCursor | null = cursor(2)): LeadsPagingAction[] => [
    { type: "reset", generation },
    { type: "first_loaded", generation, page: page(leads, next), packFields: [] },
  ];

  it("starts loading, shows the first page, and remembers where the next one starts", () => {
    expect(initialLeadsPaging().phase).toBe("loading");
    const s = run(first());
    expect(s).toMatchObject({ phase: "ready", more: "idle", next: cursor(2) });
    expect(s.leads.map((l) => l.id)).toEqual([id(3), id(2)]);
  });

  it("appends the next page after the first, and ends with no cursor on the last page", () => {
    const s = run([...first(), { type: "more_started", generation: 1 }, { type: "more_loaded", generation: 1, from: cursor(2), page: page([lead(1)], null) }]);
    expect(s.leads.map((l) => l.id)).toEqual([id(3), id(2), id(1)]);
    expect(s).toMatchObject({ next: null, more: "idle" });
  });

  it("shows loading-more while the next page is read, and starts only one at a time", () => {
    const loading = run([...first(), { type: "more_started", generation: 1 }]);
    expect(loading.more).toBe("loading");
    expect(leadsPagingReducer(loading, { type: "more_started", generation: 1 })).toBe(loading);
  });

  it("starts nothing when there is no next page or the list isn't ready", () => {
    const done = run(first(1, [lead(1)], null));
    expect(leadsPagingReducer(done, { type: "more_started", generation: 1 })).toBe(done);
    const loading = initialLeadsPaging(1);
    expect(leadsPagingReducer(loading, { type: "more_started", generation: 1 })).toBe(loading);
  });

  it("never adds a lead twice, even when a page arrives twice or overlaps the last", () => {
    const s = run([
      ...first(),
      { type: "more_started", generation: 1 },
      { type: "more_loaded", generation: 1, from: cursor(2), page: page([lead(2), lead(1)], cursor(1)) },
      { type: "more_loaded", generation: 1, from: cursor(2), page: page([lead(2), lead(1)], cursor(1)) },
    ]);
    expect(s.leads.map((l) => l.id)).toEqual([id(3), id(2), id(1)]);
    expect(s.next).toEqual(cursor(1));
  });

  it("ignores a page for a cursor that is no longer the next one", () => {
    const s = run([...first(), { type: "more_started", generation: 1 }, { type: "more_loaded", generation: 1, from: cursor(9), page: page([lead(8)], null) }]);
    expect(s.leads.map((l) => l.id)).toEqual([id(3), id(2)]);
    expect(s).toMatchObject({ more: "loading", next: cursor(2) });
  });

  it("keeps the leads already read when the next page fails, and lets it be tried again", () => {
    const failed = run([...first(), { type: "more_started", generation: 1 }, { type: "more_failed", generation: 1, from: cursor(2), error: asError("offline") }]);
    expect(failed).toMatchObject({ more: "error", phase: "ready" });
    expect(failed.moreError?.message).toBe("offline");
    expect(failed.leads).toHaveLength(2);
    const retried = leadsPagingReducer(failed, { type: "more_started", generation: 1 });
    expect(retried).toMatchObject({ more: "loading", moreError: null });
    const done = leadsPagingReducer(retried, { type: "more_loaded", generation: 1, from: cursor(2), page: page([lead(1)], null) });
    expect(done.leads).toHaveLength(3);
  });

  it("shows an error for a failed first page, and Try again starts clean", () => {
    const failed = run([{ type: "reset", generation: 1 }, { type: "first_failed", generation: 1, error: asError("offline") }]);
    expect(failed).toMatchObject({ phase: "error", leads: [] });
    const again = leadsPagingReducer(failed, { type: "reset", generation: 2 });
    expect(again).toMatchObject({ phase: "loading", error: null, generation: 2 });
  });

  it("drops an answer for an earlier try or another business, so it can't overwrite the current list", () => {
    // Business A's first page is slow; business B is chosen and answers first. A's answer arrives last and is ignored.
    const s = run([
      { type: "reset", generation: 1 },
      { type: "reset", generation: 2 },
      { type: "first_loaded", generation: 2, page: page([lead(20)], null), packFields: [] },
      { type: "first_loaded", generation: 1, page: page([lead(10)], null), packFields: [] },
      { type: "first_failed", generation: 1, error: asError("late") },
      { type: "more_loaded", generation: 1, from: cursor(10), page: page([lead(9)], null) },
    ]);
    expect(s.leads.map((l) => l.id)).toEqual([id(20)]);
    expect(s.phase).toBe("ready");
  });

  it("resets everything for a new business: no old leads, no old cursor, no old error", () => {
    const s = run([...first(), { type: "reset", generation: 2 }]);
    expect(s).toEqual(initialLeadsPaging(2));
  });
});

describe("filters across pages", () => {
  const temps = ["hot", "warm", "cold", "disqualified", null] as const;
  const all = Array.from({ length: 650 }, (_, i) => lead(i + 1, { temperature: temps[i % temps.length], score: i % temps.length === 4 ? null : (i * 7) % 100 }));

  it("applies the same filter to every page: loading in pages finds exactly what one read of everything would", () => {
    const newestFirst = [...all].reverse();
    let s = run([{ type: "reset", generation: 1 }, { type: "first_loaded", generation: 1, page: page(newestFirst.slice(0, 200), cursor(450)), packFields: [] }]);
    const filter = { temperature: "hot" as const, minScore: 50 };
    const shown = () => s.leads.filter((l) => matchesFilters(l, filter)).map((l) => l.id);
    const afterFirst = shown().length;
    for (let from = 200, n = 450; from < 650; from += 200, n -= 200) {
      const slice = newestFirst.slice(from, from + 200);
      const next = from + 200 >= 650 ? null : cursor(n - 200);
      s = run([{ type: "more_started", generation: 1 }, { type: "more_loaded", generation: 1, from: cursor(n), page: page(slice, next) }], s);
    }
    expect(s.leads).toHaveLength(650);
    expect(shown().length).toBeGreaterThan(afterFirst);
    expect(shown().sort()).toEqual(all.filter((l) => matchesFilters(l, filter)).map((l) => l.id).sort());
    expect(temperatureCounts(s.leads)).toEqual(temperatureCounts(all));
  });
});

describe("reading the newest leads again (Refresh, and Realtime when the database sends changes)", () => {
  const loaded = (): LeadsPaging =>
    run([
      { type: "reset", generation: 1 },
      { type: "first_loaded", generation: 1, page: page([lead(5), lead(4), lead(3)], cursor(3)), packFields: [] },
      { type: "more_started", generation: 1 },
      { type: "more_loaded", generation: 1, from: cursor(3), page: page([lead(2), lead(1)], null) },
    ]);

  it("shows the list as it is while it reads, one read at a time", () => {
    const s = leadsPagingReducer(loaded(), { type: "refresh_started", generation: 1 });
    expect(s).toMatchObject({ refresh: "loading", phase: "ready" });
    expect(s.leads).toHaveLength(5);
    expect(leadsPagingReducer(s, { type: "refresh_started", generation: 1 })).toBe(s);
  });

  it("does not start before the first page is shown", () => {
    const s = initialLeadsPaging(1);
    expect(leadsPagingReducer(s, { type: "refresh_started", generation: 1 })).toBe(s);
  });

  it("puts a changed lead and a new lead first, keeps every page already read, and never shows one twice", () => {
    const changed = lead(2, { updated_at: stamp(50), stage: "booked" });
    const brandNew = lead(9);
    const fresh = page([changed, brandNew, lead(5), lead(4)], cursor(4));
    const s = run([{ type: "refresh_started", generation: 1 }, { type: "refreshed", generation: 1, page: fresh }], loaded());
    expect(s.leads.map((l) => l.id)).toEqual([id(2), id(9), id(5), id(4), id(3), id(1)]);
    expect(s.leads.find((l) => l.id === id(2))?.stage).toBe("booked"); // the fresh record replaced the held one
    expect(new Set(s.leads.map((l) => l.id)).size).toBe(s.leads.length);
    expect(s).toMatchObject({ refresh: "idle", refreshError: null });
  });

  it("leaves where the next page starts alone: it is a value, and still marks where the older leads begin", () => {
    const first = run([
      { type: "reset", generation: 1 },
      { type: "first_loaded", generation: 1, page: page([lead(5), lead(4)], cursor(4)), packFields: [] },
    ]);
    const s = leadsPagingReducer(first, { type: "refreshed", generation: 1, page: page([lead(9), lead(5)], cursor(5)) });
    expect(s.next).toEqual(cursor(4));
  });

  it("is the same after the same answer twice", () => {
    const fresh = page([lead(9), lead(5)], null);
    const once = leadsPagingReducer(loaded(), { type: "refreshed", generation: 1, page: fresh });
    expect(leadsPagingReducer(once, { type: "refreshed", generation: 1, page: fresh }).leads).toEqual(once.leads);
  });

  it("keeps the list, and says the read failed, when it fails; the next try clears the note", () => {
    const failed = run([{ type: "refresh_started", generation: 1 }, { type: "refresh_failed", generation: 1, error: asError("offline") }], loaded());
    expect(failed).toMatchObject({ refresh: "error", phase: "ready" });
    expect(failed.leads).toHaveLength(5);
    expect(failed.refreshError?.message).toBe("offline");
    expect(leadsPagingReducer(failed, { type: "refresh_started", generation: 1 })).toMatchObject({ refresh: "loading", refreshError: null });
  });

  it("drops an answer that belongs to an earlier business or try", () => {
    const s = run([{ type: "refresh_started", generation: 1 }, { type: "reset", generation: 2 }, { type: "refreshed", generation: 1, page: page([lead(9)], null) }, { type: "refresh_failed", generation: 1, error: asError("late") }], loaded());
    expect(s).toEqual(initialLeadsPaging(2));
  });

  it("can run while the next page is being read, and neither overwrites the other", () => {
    const s = run(
      [
        { type: "reset", generation: 1 },
        { type: "first_loaded", generation: 1, page: page([lead(5), lead(4)], cursor(4)), packFields: [] },
        { type: "more_started", generation: 1 },
        { type: "refresh_started", generation: 1 },
        { type: "refreshed", generation: 1, page: page([lead(9), lead(5)], cursor(5)) },
        { type: "more_loaded", generation: 1, from: cursor(4), page: page([lead(3)], null) },
      ],
    );
    expect(s.leads.map((l) => l.id)).toEqual([id(9), id(5), id(4), id(3)]);
    expect(s).toMatchObject({ more: "idle", refresh: "idle", next: null });
  });
});

describe("when a re-read cannot be merged safely", () => {
  const held = [lead(5), lead(4), lead(3)];

  it("is fine when the newest page reaches back to what is held", () => {
    expect(refreshLeavesGap(held, page([lead(9), lead(5), lead(4)], cursor(4)))).toBe(false);
  });

  it("is fine when everything fits in one page (nothing more behind it)", () => {
    expect(refreshLeavesGap(held, page([lead(20), lead(19)], null))).toBe(false);
  });

  it("is a gap when the whole page is newer than everything held and more lie behind it (a burst bigger than a page)", () => {
    expect(refreshLeavesGap(held, page([lead(30), lead(29), lead(28)], cursor(28)))).toBe(true);
  });

  it("is no gap when nothing is held yet, or the page is empty", () => {
    expect(refreshLeavesGap([], page([lead(30)], cursor(30)))).toBe(false);
    expect(refreshLeavesGap(held, page([], cursor(1)))).toBe(false);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Booking } from "@/features/calendar/bookings";
import {
  answerRows,
  bookingEntry,
  buildTimeline,
  fetchLead,
  fetchLeadActivity,
  fetchLeadsPage,
  fetchPackFields,
  formatAnswer,
  groupByStage,
  LeadRow,
  matchesFilters,
  parseMinScore,
  qualificationSummary,
  STAGES,
  temperatureCounts,
  toLead,
  type Lead,
  type PackFieldInfo,
} from "./data";

const TENANT = "c0000000-0000-0000-0000-00000000000a";
const OTHER = "c0000000-0000-0000-0000-00000000000b";
const id = (n: number) => `d0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CONTACT = "e0000000-0000-0000-0000-000000000001";
const IST = "Asia/Kolkata";
const NOW = new Date("2026-10-12T05:00:00Z");

const leadRow = (over: Record<string, unknown> = {}) => ({
  id: id(1),
  tenant_id: TENANT,
  contact_id: CONTACT,
  stage: "qualified",
  score: 82,
  temperature: "hot",
  fields: { budget: { min: 6000000, max: 8000000 }, area: "Velachery" },
  owner_user_id: null,
  created_at: "2026-10-10T10:00:00+00:00",
  updated_at: "2026-10-11T10:00:00+00:00",
  contacts: { name: "Karthik R", phone: "+919812345621" },
  ...over,
});

const parsed = (over: Record<string, unknown> = {}) => toLead(LeadRow.parse(leadRow(over)));
const lead = (over: Partial<Lead> = {}): Lead => ({ ...parsed(), ...over });

// Field keys and labels as a pack would give them; any pack works, the screens never name one.
const PACK: PackFieldInfo[] = [
  { key: "area", label: "Preferred area", type: "text", required: true },
  { key: "budget", label: "Budget", type: "range_inr", required: true },
  { key: "timeline", label: "When", type: "date_range_or_month", required: false },
];

/** A stand-in for the Supabase client: one result per table, every call recorded. */
function fakeClient(results: Record<string, { data: unknown; error: unknown }>) {
  const calls: [string, string, unknown[]][] = [];
  const client = {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "in", "order", "limit", "lt", "gt"]) {
        builder[name] = (...args: unknown[]) => {
          calls.push([table, name, args]);
          return builder;
        };
      }
      const result = results[table] ?? { data: [], error: null };
      builder.maybeSingle = () => Promise.resolve(result);
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("lead rows", () => {
  it("masks the number and keeps the stored score and temperature", () => {
    const l = parsed({ contacts: { name: null, phone: "+919812345621" } });
    expect(l).toMatchObject({ name: "+91 98xxx xxx21", hasName: false, score: 82, temperature: "hot" });
    expect(JSON.stringify(l)).not.toContain("9812345621");
  });

  it("shows a temperature it doesn't know as not scored instead of failing", () => {
    expect(parsed({ temperature: "lukewarm" }).temperature).toBeNull();
  });

  it("reads the session's business's leads only", async () => {
    const { client, calls } = fakeClient({ leads: { data: [leadRow(), leadRow({ id: id(2), tenant_id: OTHER })], error: null } });
    const { leads } = await fetchLeadsPage(client, TENANT);
    expect(calls).toContainEqual(["leads", "eq", ["tenant_id", TENANT]]);
    expect(leads.map((l) => l.id)).toEqual([id(1)]);
  });

  it("finds no lead for another business's id", async () => {
    const { client, calls } = fakeClient({ leads: { data: [], error: null } });
    expect(await fetchLead(client, TENANT, id(9))).toBeNull();
    expect(calls).toContainEqual(["leads", "eq", ["tenant_id", TENANT]]);
    expect(calls).toContainEqual(["leads", "eq", ["id", id(9)]]);
  });

  it("refuses rows of the wrong shape", async () => {
    await expect(fetchLeadsPage(fakeClient({ leads: { data: [{ id: "x" }], error: null } }).client, TENANT)).rejects.toThrow(/unexpected shape/);
  });
});

describe("the board", () => {
  it("has a column for every stage, in pipeline order, plus any stage it doesn't know", () => {
    const cols = groupByStage([lead({ id: id(1), stage: "booked" }), lead({ id: id(2), stage: "archived" })]);
    expect(cols.map((c) => c.stage)).toEqual([...STAGES, "archived"]);
    expect(cols.find((c) => c.stage === "booked")?.leads.map((l) => l.id)).toEqual([id(1)]);
    expect(cols.find((c) => c.stage === "human")?.label).toBe("With staff");
    expect(cols.at(-1)?.label).toBe("Archived");
  });

  it("puts the highest score first within a column", () => {
    const [col] = groupByStage([lead({ id: id(1), stage: "new", score: 40 }), lead({ id: id(2), stage: "new", score: null }), lead({ id: id(3), stage: "new", score: 90 })]);
    expect(col.leads.map((l) => l.id)).toEqual([id(3), id(1), id(2)]);
  });

  it("filters by the stored temperature and a minimum score", () => {
    const leads = [
      lead({ id: id(1), temperature: "hot", score: 82 }),
      lead({ id: id(2), temperature: "warm", score: 55 }),
      lead({ id: id(3), temperature: "cold", score: 20 }),
      lead({ id: id(4), temperature: null, score: null }),
    ];
    const pick = (f: Parameters<typeof matchesFilters>[1]) => leads.filter((l) => matchesFilters(l, f)).map((l) => l.id);
    expect(pick({ temperature: "all", minScore: null })).toHaveLength(4);
    expect(pick({ temperature: "hot", minScore: null })).toEqual([id(1)]);
    expect(pick({ temperature: "warm", minScore: null })).toEqual([id(2)]);
    expect(pick({ temperature: "cold", minScore: null })).toEqual([id(3)]);
    expect(pick({ temperature: "unscored", minScore: null })).toEqual([id(4)]);
    expect(pick({ temperature: "all", minScore: 50 })).toEqual([id(1), id(2)]);
    expect(pick({ temperature: "cold", minScore: 50 })).toEqual([]);
    expect(temperatureCounts(leads)).toEqual({ all: 4, hot: 1, warm: 1, cold: 1, disqualified: 0, unscored: 1 });
  });

  it("never bands a score itself: a 95 stored as cold stays cold", () => {
    const l = lead({ score: 95, temperature: "cold" });
    expect(matchesFilters(l, { temperature: "hot", minScore: null })).toBe(false);
    expect(matchesFilters(l, { temperature: "cold", minScore: null })).toBe(true);
  });

  it("reads the minimum score box", () => {
    expect(parseMinScore("")).toBeNull();
    expect(parseMinScore(" 70 ")).toBe(70);
    expect(parseMinScore("7O")).toBeUndefined();
    expect(parseMinScore("-1")).toBeUndefined();
  });
});

describe("answers", () => {
  it("lists the pack's fields in its order, answered or not, then answers the pack doesn't know", () => {
    const rows = answerRows({ budget: { min: 6000000, max: 8000000 }, area: "Velachery", parking: true }, PACK);
    expect(rows).toEqual([
      { key: "area", label: "Preferred area", value: "Velachery", required: true, inPack: true },
      { key: "budget", label: "Budget", value: "₹60,00,000 – ₹80,00,000", required: true, inPack: true },
      { key: "timeline", label: "When", value: null, required: false, inPack: true },
      { key: "parking", label: "Parking", value: "Yes", required: false, inPack: false },
    ]);
  });

  it("still shows every answer when there's no pack to label them", () => {
    expect(answerRows({ preferred_area: "OMR", group_size: 4 }, [])).toEqual([
      { key: "preferred_area", label: "Preferred area", value: "OMR", required: false, inPack: false },
      { key: "group_size", label: "Group size", value: "4", required: false, inPack: false },
    ]);
  });

  it("treats blank answers as unanswered", () => {
    expect(answerRows({ area: "  ", budget: null }, PACK).every((r) => r.value === null)).toBe(true);
    expect(answerRows({}, [])).toEqual([]);
  });

  it("writes any stored shape as text", () => {
    expect(formatAnswer(["2BHK", "3BHK"])).toBe("2BHK, 3BHK");
    expect(formatAnswer({ from: "2026-11", to: "2026-12" })).toBe("2026-11 – 2026-12");
    expect(formatAnswer({ max: 500000 }, "range_inr")).toBe("Up to ₹5,00,000");
    expect(formatAnswer({ adults: 2, kids: 1 })).toBe("Adults: 2, Kids: 1");
    expect(formatAnswer(false)).toBe("No");
  });

  it("summarises the first answers for a card", () => {
    expect(qualificationSummary({ budget: 7000000, area: "Velachery" }, PACK)).toBe("Preferred area: Velachery · Budget: ₹70,00,000");
    expect(qualificationSummary({}, PACK)).toBeNull();
  });

  it("labels answers from the business's own pack version", async () => {
    const { client, calls } = fakeClient({
      tenants: { data: { id: TENANT, vertical: "any-pack", vertical_version: 3 }, error: null },
      vertical_packs: { data: { definition: { fields: [{ key: "area", label: "Area", type: "text", required: true }] } }, error: null },
    });
    expect(await fetchPackFields(client, TENANT)).toEqual([{ key: "area", label: "Area", type: "text", required: true }]);
    expect(calls).toContainEqual(["tenants", "eq", ["id", TENANT]]);
    expect(calls).toContainEqual(["vertical_packs", "eq", ["key", "any-pack"]]);
    expect(calls).toContainEqual(["vertical_packs", "eq", ["version", 3]]);
  });

  it("has no labels, rather than an error, when the pack isn't stored", async () => {
    const { client } = fakeClient({
      tenants: { data: { id: TENANT, vertical: "any-pack", vertical_version: 1 }, error: null },
      vertical_packs: { data: null, error: null },
    });
    expect(await fetchPackFields(client, TENANT)).toEqual([]);
  });
});

describe("timeline", () => {
  const booking = (over: Partial<Booking> = {}): Booking => ({
    id: "b0000000-0000-0000-0000-000000000001",
    leadId: id(1),
    resourceId: "a0000000-0000-0000-0000-000000000001",
    resourceName: "Asha",
    serviceName: "Consultation",
    kind: "slot",
    status: "confirmed",
    start: "2026-10-14T04:30:00.000Z",
    end: "2026-10-14T05:30:00.000Z",
    holdExpiresAt: null,
    createdAt: "2026-10-11T09:00:00.000Z",
    rescheduledFrom: null,
    cancelReason: null,
    customerName: null,
    phoneMasked: null,
    ...over,
  });

  it("describes bookings, moves and lapsed holds as they are now", () => {
    expect(bookingEntry(booking(), NOW, IST).text).toBe("Consultation with Asha for Wed 14 Oct, 10:00 am · Confirmed");
    expect(bookingEntry(booking({ rescheduledFrom: "b0000000-0000-0000-0000-000000000009" }), NOW, IST)).toMatchObject({ label: "Booking moved", text: "Consultation with Asha, moved to Wed 14 Oct, 10:00 am · Confirmed" });
    expect(bookingEntry(booking({ status: "held", holdExpiresAt: "2026-10-11T09:10:00Z" }), NOW, IST).text).toMatch(/· Hold expired$/);
    expect(bookingEntry(booking({ status: "cancelled", cancelReason: "replaced" }), NOW, IST).text).toMatch(/Cancelled \(the customer picked another time\)$/);
    expect(bookingEntry(booking({ kind: "callback", resourceId: null, resourceName: null, serviceName: null }), NOW, IST).text).toBe("Callback for Wed 14 Oct, 10:00 am · Confirmed");
  });

  it("puts the lead, the chat, handovers and bookings in time order", () => {
    const timeline = buildTimeline({
      lead: lead({ createdAt: "2026-10-11T08:00:00.000Z" }),
      conversations: [
        { id: "f0000000-0000-0000-0000-000000000001", tenant_id: TENANT, contact_id: CONTACT, mode: "ai", created_at: "2026-10-11T08:00:00.000Z", handoffs: [{ id: "f1000000-0000-0000-0000-000000000001", trigger: "asked_human", picked_at: "2026-10-11T08:30:00.000Z", resolved_at: null }] },
      ],
      messages: [
        { id: "f2000000-0000-0000-0000-000000000002", tenant_id: TENANT, conversation_id: "f0000000-0000-0000-0000-000000000001", sender: "ai", kind: null, body: "What budget?", template_name: null, created_at: "2026-10-11T08:01:00.000Z" },
        { id: "f2000000-0000-0000-0000-000000000001", tenant_id: TENANT, conversation_id: "f0000000-0000-0000-0000-000000000001", sender: "customer", kind: "text", body: "Hi, 3BHK?", template_name: null, created_at: "2026-10-11T08:00:30.000Z" },
      ],
      bookings: [booking()],
      now: NOW,
      timeZone: IST,
    });
    expect(timeline.map((t) => [t.kind, t.label])).toEqual([
      ["lead", "Lead"],
      ["customer", "Customer"],
      ["ai", "AI"],
      ["handoff", "Handover"],
      ["booking", "Booking"],
    ]);
    expect(timeline[3].text).toBe("Staff took over the chat (asked human).");
  });

  it("reads activity for this lead's contact and this business only", async () => {
    const conv = { id: "f0000000-0000-0000-0000-000000000001", tenant_id: TENANT, contact_id: CONTACT, mode: "ai", created_at: "2026-10-11T08:00:00+00:00", handoffs: [{ id: "f1000000-0000-0000-0000-000000000001", trigger: "complaint", picked_at: null, resolved_at: null }] };
    const { client, calls } = fakeClient({ conversations: { data: [conv], error: null }, bookings: { data: [], error: null }, messages: { data: [], error: null } });
    const activity = await fetchLeadActivity(client, TENANT, lead(), NOW, IST);
    expect(calls).toContainEqual(["conversations", "eq", ["tenant_id", TENANT]]);
    expect(calls).toContainEqual(["conversations", "eq", ["contact_id", CONTACT]]);
    expect(calls).toContainEqual(["bookings", "eq", ["lead_id", id(1)]]);
    expect(calls).toContainEqual(["messages", "in", ["conversation_id", [conv.id]]]);
    expect(activity).toMatchObject({ latestConversationId: conv.id, openHandoffs: [{ trigger: "complaint" }], messagesTruncated: false });
  });
});

describe("industry-agnostic Day 3 code", () => {
  // The screens work from generic leads, stages, resources and bookings; nothing branches on a pack.
  const INDUSTRY = /real[-_ ]?estate|salon|interiors?\b|clinic|hotel|restaurant|tours?[-_ ]travel|stylist|plumber/i;
  const files = ["features/leads", "features/calendar", "features/settings"].flatMap((dir) =>
    readdirSync(join(process.cwd(), dir))
      .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.startsWith("pakka-"))
      .map((f) => join(dir, f)),
  );

  it.each(files)("%s names no industry", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source.match(INDUSTRY)?.[0] ?? null).toBeNull();
    expect(source).not.toMatch(/\b(vertical|industry)\s*===/);
  });
});

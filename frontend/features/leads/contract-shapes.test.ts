import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOOKING_KINDS, BOOKING_STATUSES } from "@/features/calendar/bookings";
import {
  answerRows,
  formatAnswer,
  groupByStage,
  LeadRow,
  matchesFilters,
  parseLeads,
  qualificationSummary,
  STAGES,
  stageLabel,
  TEMPERATURE_LABEL,
  TEMPERATURE_STYLE,
  TEMPERATURES,
  temperatureCounts,
  toLead,
  type Lead,
  type PackFieldInfo,
} from "./data";

// Contract-shape tests for what the leads screens read (leads.fields, leads.stage, leads.score, leads.temperature).
//
// These pin what the frontend does TODAY with each shape. They do not define the backend's contract. Open questions
// for Dev 1 (the engine that writes these columns), kept visible here so nobody reads a passing test as an agreement:
//
//   - Units of `range_inr`. backend/src/agent/packs/field-schema.ts accepts a string or a number and says "formats are
//     not defined anywhere yet"; the extraction prompt (extraction_v2.ts) says "a number [rupees], or a range as the
//     customer wrote it, like 50-60L". The screens therefore show a number as rupees and a string exactly as written.
//     NOTHING here converts "lakh" or "L" to rupees, and no test may assume it does.
//   - `{ min, max }` objects. The frontend can show them, but field-schema.ts does not currently accept an object for
//     range_inr, so the backend cannot store one today. Tested as "what the screen does if one appears".
//   - Whether leads.score and leads.temperature are ever written: at the time of writing nothing in backend/src writes
//     them, so every real lead is "Not scored". The screens show whatever is stored and never band a score themselves.

const TENANT = "c0000000-0000-0000-0000-00000000000a";
const CONTACT = "e0000000-0000-0000-0000-000000000001";
const id = (n: number) => `d0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const leadRow = (over: Record<string, unknown> = {}) => ({
  id: id(1),
  tenant_id: TENANT,
  contact_id: CONTACT,
  stage: "new",
  score: null,
  temperature: null,
  fields: {},
  owner_user_id: null,
  created_at: "2026-10-10T10:00:00+00:00",
  updated_at: "2026-10-11T10:00:00+00:00",
  contacts: { name: "Karthik R", phone: "+919812345621" },
  ...over,
});
const lead = (over: Record<string, unknown> = {}): Lead => toLead(LeadRow.parse(leadRow(over)));

const PACK: PackFieldInfo[] = [
  { key: "area", label: "Preferred area", type: "text", required: true },
  { key: "budget", label: "Budget", type: "range_inr", required: true },
  { key: "timeline", label: "When", type: "date_range_or_month", required: false },
  { key: "decision_maker", label: "Buyer or co-buyer?", type: "boolean", required: false },
];

describe("range_inr as a number: shown as rupees with Indian grouping", () => {
  it.each([
    [0, "₹0"],
    [80, "₹80"],
    [999, "₹999"],
    [100000, "₹1,00,000"],
    [8000000, "₹80,00,000"],
    [10000000, "₹1,00,00,000"],
    [1234567890, "₹1,23,45,67,890"],
    [1234.5, "₹1,234.5"],
  ])("%s becomes %s", (value, text) => {
    expect(formatAnswer(value, "range_inr")).toBe(text);
  });

  it("does not read a small number as lakh: 80 is ₹80, never ₹80,00,000", () => {
    // Units are undefined in the backend contract (see the header). The screen shows the stored number as rupees.
    expect(formatAnswer(80, "range_inr")).toBe("₹80");
    expect(formatAnswer(80, "range_inr")).not.toContain("00,000");
  });

  it("groups other numbers the Indian way too, but without the rupee sign", () => {
    expect(formatAnswer(8000000)).toBe("80,00,000");
    expect(formatAnswer(8000000, null)).toBe("80,00,000");
    expect(formatAnswer(8000000, "int")).toBe("80,00,000");
    expect(formatAnswer(0)).toBe("0");
  });
});

describe("range_inr as a string: shown exactly as stored", () => {
  it.each([
    ["80 lakh", "80 lakh"],
    ["50-60L", "50-60L"],
    ["₹80L–90L", "₹80L–90L"],
    ["  1.2 Cr  ", "1.2 Cr"],
    ["8000000", "8000000"],
  ])("%j is shown as %j", (value, text) => {
    expect(formatAnswer(value, "range_inr")).toBe(text);
  });

  it("never converts lakh to rupees and never groups a numeric string", () => {
    expect(formatAnswer("80 lakh", "range_inr")).not.toMatch(/₹|,/);
    // A number-looking string is not a number: it keeps the digits the engine stored.
    expect(formatAnswer("8000000", "range_inr")).toBe("8000000");
  });

  it("shows a blank string as no answer", () => {
    expect(formatAnswer("   ", "range_inr")).toBe("");
    expect(answerRows({ budget: "   " }, PACK).find((r) => r.key === "budget")?.value).toBeNull();
  });
});

describe("range_inr as { min, max }: what the screen does if one is stored", () => {
  // field-schema.ts does not accept an object for range_inr today, so the backend cannot write one. Kept because
  // the screens were built to read it (features/leads/data.ts), and a change there must be deliberate.
  it.each([
    [{ min: 6000000, max: 8000000 }, "₹60,00,000 – ₹80,00,000"],
    [{ from: 6000000, to: 8000000 }, "₹60,00,000 – ₹80,00,000"],
    [{ min: 6000000 }, "From ₹60,00,000"],
    [{ max: 8000000 }, "Up to ₹80,00,000"],
    [{ min: null, max: 8000000 }, "Up to ₹80,00,000"],
    [{ min: 6000000, max: null }, "From ₹60,00,000"],
    [{ min: 0, max: 5000000 }, "₹0 – ₹50,00,000"],
  ])("%j reads as %j", (value, text) => {
    expect(formatAnswer(value, "range_inr")).toBe(text);
  });

  it("keeps strings inside a range as written, with no lakh conversion", () => {
    expect(formatAnswer({ min: "70 lakh", max: "80 lakh" }, "range_inr")).toBe("70 lakh – 80 lakh");
  });

  it("shows an object with neither bound as no answer", () => {
    expect(formatAnswer({ min: null, max: null }, "range_inr")).toBe("");
    expect(formatAnswer({}, "range_inr")).toBe("");
    expect(answerRows({ budget: {} }, PACK).find((r) => r.key === "budget")?.value).toBeNull();
  });

  it("does not check that min is below max", () => {
    // Preserved current behaviour: the screen shows what is stored; deciding it is wrong is the engine's job.
    expect(formatAnswer({ min: 8000000, max: 6000000 }, "range_inr")).toBe("₹80,00,000 – ₹60,00,000");
  });
});

describe("missing, null and malformed answers", () => {
  it("treats null, undefined, blank strings and empty lists as unanswered", () => {
    const answers = { area: null, budget: undefined, timeline: "  ", decision_maker: [] };
    expect(answerRows(answers, PACK).map((r) => r.value)).toEqual([null, null, null, null]);
    expect(qualificationSummary(answers, PACK)).toBeNull();
  });

  it("keeps zero and false: they are answers", () => {
    const rows = answerRows({ budget: 0, decision_maker: false }, PACK);
    expect(rows.find((r) => r.key === "budget")?.value).toBe("₹0");
    expect(rows.find((r) => r.key === "decision_maker")?.value).toBe("No");
  });

  it("drops empty members of a list and shows what is left", () => {
    expect(formatAnswer(["2BHK", null, "", "3BHK"])).toBe("2BHK, 3BHK");
    expect(formatAnswer([null, ""])).toBe("");
  });

  it("writes nested objects as readable text, skipping empty parts", () => {
    expect(formatAnswer({ adults: 2, kids: 0, pets: null, note: "" })).toBe("Adults: 2, Kids: 0");
  });

  it("shows a stored answer the pack doesn't have, labelled from its key, and skips empty ones", () => {
    const rows = answerRows({ area: "OMR", loan_status: "approved", extra: null, other: "" }, PACK);
    expect(rows.filter((r) => !r.inPack)).toEqual([{ key: "loan_status", label: "Loan status", value: "approved", required: false, inPack: false }]);
  });

  it("reads fields that are not an object as no answers instead of failing the lead", () => {
    for (const fields of ["oops", null, [1, 2], 5, undefined]) {
      expect(lead({ fields }).answers, JSON.stringify(fields)).toEqual({});
    }
  });

  it("keeps a valid fields object whatever is inside it", () => {
    const fields = { area: "OMR", budget: { min: 1 }, nested: { deep: [1, { x: null }] } };
    expect(lead({ fields }).answers).toEqual(fields);
  });
});

describe("stages", () => {
  it("lists the stages the database allows, in pipeline order, and nothing else", () => {
    expect([...STAGES]).toEqual(["new", "engaged", "qualified", "booked", "visited", "won", "lost", "nurture", "human"]);
  });

  it("labels qualified and booked", () => {
    expect(stageLabel("qualified")).toBe("Qualified");
    expect(stageLabel("booked")).toBe("Booked");
  });

  it("labels a stage it doesn't know from its key instead of hiding it", () => {
    expect(stageLabel("follow_up")).toBe("Follow up");
    expect(stageLabel("archived")).toBe("Archived");
  });

  it("puts a qualified lead before the booked column, and each lead in its own column", () => {
    const cols = groupByStage([lead({ id: id(1), stage: "booked", score: 91, temperature: "hot" }), lead({ id: id(2), stage: "qualified", score: 74, temperature: "hot" })]);
    const order = cols.map((c) => c.stage);
    expect(order.indexOf("qualified")).toBeLessThan(order.indexOf("booked"));
    expect(cols.find((c) => c.stage === "qualified")?.leads.map((l) => l.id)).toEqual([id(2)]);
    expect(cols.find((c) => c.stage === "booked")?.leads.map((l) => l.id)).toEqual([id(1)]);
  });

  it("adds a column for each unknown stage, after the known ones, in alphabetical order", () => {
    const cols = groupByStage([lead({ id: id(1), stage: "zeta" }), lead({ id: id(2), stage: "archived" })]);
    expect(cols.map((c) => c.stage).slice(STAGES.length)).toEqual(["archived", "zeta"]);
  });

  it("keeps a lead's stage as stored even when it isn't one of the known ones", () => {
    expect(lead({ stage: "something_new" }).stage).toBe("something_new");
  });

  it("refuses a lead with no stage (the column is not null) rather than guessing one", () => {
    expect(LeadRow.safeParse(leadRow({ stage: null })).success).toBe(false);
    expect(LeadRow.safeParse(leadRow({ stage: undefined })).success).toBe(false);
    expect(() => parseLeads([leadRow({ stage: null })], TENANT)).toThrow(/unexpected shape/);
  });
});

describe("temperature and score", () => {
  it("lists the temperatures the database allows", () => {
    expect([...TEMPERATURES]).toEqual(["hot", "warm", "cold", "disqualified"]);
    for (const t of TEMPERATURES) {
      expect(TEMPERATURE_LABEL[t]).toBeTruthy();
      expect(TEMPERATURE_STYLE[t]).toBeDefined();
    }
  });

  it("reads disqualified as stored, with or without a score", () => {
    expect(lead({ temperature: "disqualified", score: 12 })).toMatchObject({ temperature: "disqualified", score: 12 });
    expect(lead({ temperature: "disqualified", score: null })).toMatchObject({ temperature: "disqualified", score: null });
  });

  it("filters disqualified leads on their own and counts them", () => {
    const leads = [
      lead({ id: id(1), temperature: "disqualified", score: 12 }),
      lead({ id: id(2), temperature: "hot", score: 80 }),
      lead({ id: id(3), temperature: null, score: null }),
    ];
    const pick = (f: Parameters<typeof matchesFilters>[1]) => leads.filter((l) => matchesFilters(l, f)).map((l) => l.id);
    expect(pick({ temperature: "disqualified", minScore: null })).toEqual([id(1)]);
    expect(pick({ temperature: "hot", minScore: null })).toEqual([id(2)]);
    expect(pick({ temperature: "unscored", minScore: null })).toEqual([id(3)]);
    expect(temperatureCounts(leads)).toEqual({ all: 3, hot: 1, warm: 0, cold: 0, disqualified: 1, unscored: 1 });
  });

  it("never turns a high score on a disqualified lead into hot", () => {
    const l = lead({ temperature: "disqualified", score: 95 });
    expect(matchesFilters(l, { temperature: "hot", minScore: null })).toBe(false);
    expect(matchesFilters(l, { temperature: "disqualified", minScore: null })).toBe(true);
  });

  it("leaves out a lead with no score when a minimum score is set", () => {
    expect(matchesFilters(lead({ temperature: "disqualified", score: null }), { temperature: "all", minScore: 0 })).toBe(false);
    expect(matchesFilters(lead({ temperature: "cold", score: 0 }), { temperature: "all", minScore: 0 })).toBe(true);
  });

  it.each(["lukewarm", "HOT", "", 5, undefined, null])("shows temperature %j as not scored instead of failing the read", (temperature) => {
    expect(lead({ temperature }).temperature).toBeNull();
  });

  it("keeps a score as stored, decimals included, and does not band it", () => {
    expect(lead({ score: 82.5, temperature: null })).toMatchObject({ score: 82.5, temperature: null });
    expect(lead({ score: 0, temperature: "cold" }).score).toBe(0);
  });

  it("refuses a score that isn't a number or null rather than guessing", () => {
    // Preserved current behaviour: a wrong-shaped score fails the whole read (the board shows its error state).
    expect(LeadRow.safeParse(leadRow({ score: "82" })).success).toBe(false);
    expect(LeadRow.safeParse(leadRow({ score: undefined })).success).toBe(false);
    expect(() => parseLeads([leadRow({ score: "82" })], TENANT)).toThrow(/unexpected shape/);
  });
});

describe("the screens' lists match the database's constraints", () => {
  // Reads the migrations (read-only) so a backend change to an allowed value fails here, not silently on screen.
  // A failure means a migration changed the allowed values: update data.ts / bookings.ts deliberately, not this test.
  const migration = (file: string) => readFileSync(join(process.cwd(), "..", "supabase", "migrations", file), "utf8");
  const values = (sql: string, pattern: RegExp): string[] => {
    const match = pattern.exec(sql);
    if (!match) throw new Error(`constraint not found: ${pattern}`);
    return (match[1].match(/'([^']+)'/g) ?? []).map((s) => s.slice(1, -1));
  };

  it("lead stages", () => {
    expect(values(migration("0001_init.sql"), /stage in \(([^)]*)\)/).sort()).toEqual([...STAGES].sort());
  });

  it("lead temperatures", () => {
    expect(values(migration("0001_init.sql"), /temperature in \(([^)]*)\)/).sort()).toEqual([...TEMPERATURES].sort());
  });

  it("booking statuses", () => {
    expect(values(migration("0015_booking_engine.sql"), /bookings_status_check check \(status in\s*\(([^)]*)\)/).sort()).toEqual([...BOOKING_STATUSES].sort());
  });

  it("booking kinds", () => {
    expect(values(migration("0002_packs_and_bookings.sql"), /check \(kind in \(([^)]*)\)/).sort()).toEqual([...BOOKING_KINDS].sort());
  });
});

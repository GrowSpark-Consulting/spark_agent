import { AGENT_PERSONA_MAX_LENGTH, AGENT_TRIGGER_KEYS, AgentSettings, UpdateAgentSettings, type TenantContext } from "@pakka/types";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/errors";
import { fakeSettingsDb, type Row, type SettingsDbHooks } from "../../test-support/fake-settings-db";
import { parseReplySettings } from "../pipeline/persona";
import { HANDOFF_TRIGGERS, getAgentSettings, updateAgentSettings, type AgentSettingsDeps } from "./agent-settings";

// GET and PATCH /api/agent/settings: what the Agent settings screen reads and saves in `tenants.agent_settings` (the keys agent/pipeline/persona.ts reads:
// persona, tone, privacyNotice, bookingServiceId, handoffTriggers). The route merges into the stored JSON and never replaces it, only owners and admins
// change it, the business always comes from the verified session, and every change is in the audit log. The database here is a recorder (it applies
// the filters a query makes, so a missing business filter shows); a real local database confirmed the compare-and-set it relies on.

const A = "e0000000-0000-4000-8000-00000000000a";
const B = "e0000000-0000-4000-8000-00000000000b";
const USER = "f1000000-0000-4000-8000-000000000001";
const SITE_VISIT = "d6000000-0000-4000-8000-000000000011";
const OTHER_SERVICE = "d6000000-0000-4000-8000-000000000012";
const OFF_SERVICE = "d6000000-0000-4000-8000-000000000013";
const FOREIGN_SERVICE = "d6000000-0000-4000-8000-000000000099";

const context = (role: TenantContext["role"] = "owner", tenantId = A): TenantContext => ({
  user: { id: USER, email: "owner@example.com" },
  role,
  tenant: { id: tenantId, name: "Sunrise Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "growth", trialEndsAt: null },
});

function world(settings: unknown = {}, hooks: SettingsDbHooks = {}, otherSettings: unknown = { persona: "Other Biz", tone: "formal" }) {
  const t = fakeSettingsDb(
    {
      tenants: [
        { id: A, agent_settings: settings },
        { id: B, agent_settings: otherSettings },
      ],
      services: [
        { id: SITE_VISIT, tenant_id: A, active: true },
        { id: OTHER_SERVICE, tenant_id: A, active: true },
        { id: OFF_SERVICE, tenant_id: A, active: false },
        { id: FOREIGN_SERVICE, tenant_id: B, active: true },
      ],
    },
    hooks,
  );
  const audit = vi.fn(async () => {});
  const deps: AgentSettingsDeps = { db: t.db, audit };
  return { ...t, deps, audit, stored: () => t.tables.tenants[0].agent_settings as Row, otherStored: () => t.tables.tenants[1].agent_settings };
}

const failure = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as AppError;

describe("GET: the current settings, as the agent reads them", () => {
  it("answers the defaults for a business with nothing saved", async () => {
    const w = world({});
    const view = await getAgentSettings(context(), w.deps);
    expect(view).toMatchObject({ persona: null, tone: "friendly", privacyNotice: false, bookingServiceId: null });
    expect(view.handoffTriggers.map((t) => t.key)).toEqual(["kb_gap", "asked_human", "complaint", "negotiation", "hot_lead"]);
    expect(view.handoffTriggers.every((t) => t.enabled)).toBe(true);
  });

  it("answers what is saved, cleaned the way the agent cleans it, and a trigger the business switched off as off", async () => {
    const w = world({ persona: "  Priya!!  ", tone: "formal", privacyNotice: true, bookingServiceId: SITE_VISIT, handoffTriggers: [{ key: "complaint", enabled: false }] });
    const view = await getAgentSettings(context(), w.deps);
    expect(view).toMatchObject({ persona: "Priya", tone: "formal", privacyNotice: true, bookingServiceId: SITE_VISIT });
    expect(view.handoffTriggers.find((t) => t.key === "complaint")?.enabled).toBe(false);
    expect(view.handoffTriggers.find((t) => t.key === "kb_gap")?.enabled).toBe(true);
  });

  it("never shows a value the agent would ignore: a tone it does not know is 'friendly'", async () => {
    expect((await getAgentSettings(context(), world({ tone: "warm" }).deps)).tone).toBe("friendly");
  });

  it("is the same view whatever the stored value is, even when it is not an object", async () => {
    for (const odd of [null, [], "text", 7]) expect((await getAgentSettings(context(), world(odd).deps)).tone).toBe("friendly");
  });

  it("is open to every member, staff included", async () => {
    for (const role of ["owner", "admin", "staff"] as const) await expect(getAgentSettings(context(role), world({}).deps)).resolves.toBeDefined();
  });

  it("reads only the caller's own business", async () => {
    const w = world({ persona: "Mine" });
    expect((await getAgentSettings(context("owner", A), w.deps)).persona).toBe("Mine");
    expect((await getAgentSettings(context("owner", B), w.deps)).persona).toBe("Other Biz");
    for (const call of w.calls) expect(call.filters.some((f) => f.column === "id" || f.column === "tenant_id")).toBe(true);
  });

  it("labels the five triggers with what the agent does for each, and which are urgent", () => {
    expect(HANDOFF_TRIGGERS.map((t) => [t.key, t.highPriority])).toEqual([
      ["kb_gap", false],
      ["asked_human", true],
      ["complaint", true],
      ["negotiation", true],
      ["hot_lead", false],
    ]);
    for (const t of HANDOFF_TRIGGERS) {
      expect(t.label.length).toBeGreaterThan(5);
      expect(t.example.length).toBeGreaterThan(5);
    }
  });
});

describe("the shared contract (@pakka/types): the route and the screen cannot drift", () => {
  it("answers the shape the screen is typed with, for a GET and for a PATCH", async () => {
    const w = world({ persona: "Priya", handoffTriggers: [{ key: "gap", enabled: false }] });
    expect(AgentSettings.safeParse(await getAgentSettings(context(), w.deps)).success).toBe(true);
    expect(AgentSettings.safeParse(await updateAgentSettings(context(), { tone: "formal" }, w.deps)).success).toBe(true);
  });

  it("shows the five triggers in the order, and with the keys, of AGENT_TRIGGER_KEYS", () => {
    expect(HANDOFF_TRIGGERS.map((t) => t.key)).toEqual([...AGENT_TRIGGER_KEYS]);
  });

  it("accepts and refuses the same bodies as the screen's own schema, apart from the persona's wording (which only the server judges)", async () => {
    const bodies: unknown[] = [
      {},
      { tone: "friendly" },
      { tone: "formal", privacyNotice: false },
      { tone: "warm" },
      { privacyNotice: "yes" },
      { bookingServiceId: null },
      { bookingServiceId: "nope" },
      { persona: null },
      { handoffTriggers: [{ key: "kb_gap", enabled: false }] },
      { handoffTriggers: AGENT_TRIGGER_KEYS.map((key) => ({ key, enabled: true })) },
      { handoffTriggers: [] },
      { handoffTriggers: [{ key: "stuck", enabled: true }] },
      { handoffTriggers: [{ key: "gap", enabled: true }] },
      { handoffTriggers: [{ key: "kb_gap" }] },
      { handoffTriggers: [{ key: "kb_gap", enabled: true, extra: 1 }] },
      { handoffTriggers: [{ key: "kb_gap", enabled: true }, { key: "kb_gap", enabled: false }] },
      { unknown: true },
      { tone: "formal", tenantId: A },
      null,
      [],
      "tone",
    ];
    for (const body of bodies) {
      const shared = UpdateAgentSettings.safeParse(body).success;
      const server = await updateAgentSettings(context(), body, world({}).deps).then(
        () => true,
        (e: unknown) => {
          if (e instanceof AppError && e.code === "validation_failed") return false;
          throw e;
        },
      );
      expect(server, `the server and the shared schema disagree about ${JSON.stringify(body)}`).toBe(shared);
    }
  });

  it("is stricter than the shared schema only about the persona: too long, or not a name", async () => {
    expect(UpdateAgentSettings.safeParse({ persona: "x".repeat(AGENT_PERSONA_MAX_LENGTH + 1) }).success).toBe(true);
    const error = await failure(updateAgentSettings(context(), { persona: "x".repeat(AGENT_PERSONA_MAX_LENGTH + 1) }, world({}).deps));
    expect(error.fields?.persona).toContain(String(AGENT_PERSONA_MAX_LENGTH));
  });
});

describe("PATCH: who may change it", () => {
  it.each(["owner", "admin"] as const)("lets an %s", async (role) => {
    const w = world({});
    await expect(updateAgentSettings(context(role), { tone: "formal" }, w.deps)).resolves.toMatchObject({ tone: "formal" });
    expect(w.stored().tone).toBe("formal");
  });

  it("refuses staff before reading or writing anything, naming an owner or admin", async () => {
    const w = world({});
    const error = await failure(updateAgentSettings(context("staff"), { tone: "formal" }, w.deps));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("forbidden");
    expect(error.message).toMatch(/^Only an owner or admin can /);
    expect(w.calls).toEqual([]);
  });
});

describe("PATCH: what it accepts", () => {
  it.each([
    [{}, "form"],
    [{ unknown: 1 }, "unknown"],
    [{ tone: "warm" }, "tone"],
    [{ tone: 5 }, "tone"],
    [{ privacyNotice: "yes" }, "privacyNotice"],
    [{ persona: 5 }, "persona"],
    [{ persona: "x".repeat(31) }, "persona"],
    [{ persona: "Priya, from our <b>team</b>" }, "persona"],
    [{ persona: "I am the assistant of the best business in town" }, "persona"],
    [{ bookingServiceId: "not-a-guid" }, "bookingServiceId"],
    [{ bookingServiceId: 5 }, "bookingServiceId"],
    [{ handoffTriggers: [] }, "handoffTriggers"],
    [{ handoffTriggers: "all" }, "handoffTriggers"],
    [{ handoffTriggers: [{ key: "stuck", enabled: false }] }, "handoffTriggers"],
    [{ handoffTriggers: [{ key: "opt_out", enabled: false }] }, "handoffTriggers"],
    [{ handoffTriggers: [{ key: "credits_exhausted", enabled: false }] }, "handoffTriggers"],
    [{ handoffTriggers: [{ key: "gap", enabled: false }] }, "handoffTriggers"], // an alias is read, never written
    [{ handoffTriggers: [{ key: "kb_gap" }] }, "handoffTriggers"],
    [{ handoffTriggers: [{ key: "kb_gap", enabled: "no" }] }, "handoffTriggers"],
    [{ handoffTriggers: [{ key: "kb_gap", enabled: false, extra: 1 }] }, "handoffTriggers"],
    [{ handoffTriggers: [{ key: "kb_gap", enabled: false }, { key: "kb_gap", enabled: true }] }, "handoffTriggers"],
    [null, "form"],
    [[], "form"],
    ["tone=formal", "form"],
  ])("refuses %j with a field error on %s, and changes nothing", async (body, field) => {
    const w = world({ tone: "friendly" });
    const error = await failure(updateAgentSettings(context(), body, w.deps));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("validation_failed");
    expect(error.fields).toHaveProperty(field);
    expect(w.tables.audit_logs).toEqual([]);
    expect(w.calls.filter((c) => c.op !== "select")).toEqual([]);
    expect(w.stored()).toEqual({ tone: "friendly" });
  });

  it.each([
    [{ tone: "friendly" }],
    [{ tone: "formal" }],
    [{ privacyNotice: true }],
    [{ privacyNotice: false }],
    [{ persona: "Priya" }],
    [{ persona: "பிரியா" }],
    [{ persona: "Dr. A&B-Co" }],
    [{ persona: "x".repeat(30) }],
    [{ persona: "" }],
    [{ persona: "Line\nbreak" }], // a line break is tidied to a space
    [{ persona: null }],
    [{ bookingServiceId: null }],
    [{ handoffTriggers: [{ key: "kb_gap", enabled: false }] }],
    [{ tone: "formal", persona: "Ravi", privacyNotice: true, handoffTriggers: HANDOFF_TRIGGERS.map((t) => ({ key: t.key, enabled: true })) }],
  ])("accepts %j", async (body) => {
    await expect(updateAgentSettings(context(), body, world({}).deps)).resolves.toBeDefined();
  });

  it("cleans a persona the way the agent does: spaces tidied, and only a name goes in", async () => {
    const w = world({});
    await updateAgentSettings(context(), { persona: "  Priya   Sharma  " }, w.deps);
    expect(w.stored().persona).toBe("Priya Sharma");
    expect(parseReplySettings(w.stored()).persona).toBe("Priya Sharma");
  });
});

describe("PATCH: merges into the stored settings, never replaces them", () => {
  const FULL = {
    persona: "Priya",
    tone: "formal",
    privacyNotice: true,
    bookingServiceId: SITE_VISIT,
    handoffTriggers: [
      { key: "kb_gap", enabled: false },
      { key: "complaint", enabled: true, label: "kept as it was" },
    ],
    languages: ["en", "ta"], // a key this route does not know about
    futureThing: { nested: [1, 2, 3] },
  };

  it("changes only the keys it was given, and keeps every other, including keys it does not know", async () => {
    const w = world(structuredClone(FULL));
    await updateAgentSettings(context(), { tone: "friendly" }, w.deps);
    expect(w.stored()).toEqual({ ...FULL, tone: "friendly" });
  });

  it.each([
    [{ persona: "Ravi" }, { persona: "Ravi" }],
    [{ privacyNotice: false }, { privacyNotice: false }],
    [{ bookingServiceId: OTHER_SERVICE }, { bookingServiceId: OTHER_SERVICE }],
  ])("%j changes that key alone", async (body, expected) => {
    const w = world(structuredClone(FULL));
    await updateAgentSettings(context(), body, w.deps);
    expect(w.stored()).toEqual({ ...FULL, ...expected });
  });

  it("clears the persona or the service with null (the key is removed, not stored as null)", async () => {
    const w = world(structuredClone(FULL));
    await updateAgentSettings(context(), { persona: null, bookingServiceId: null }, w.deps);
    expect(w.stored()).not.toHaveProperty("persona");
    expect(w.stored()).not.toHaveProperty("bookingServiceId");
    expect(w.stored().tone).toBe("formal");
    await updateAgentSettings(context(), { persona: "  " }, world(structuredClone(FULL)).deps);
  });

  it("merges the triggers by key: the ones not sent keep their state and their other properties", async () => {
    const w = world(structuredClone(FULL));
    await updateAgentSettings(context(), { handoffTriggers: [{ key: "negotiation", enabled: false }] }, w.deps);
    expect(w.stored().handoffTriggers).toEqual([
      { key: "kb_gap", enabled: false },
      { key: "complaint", enabled: true, label: "kept as it was" },
      { key: "negotiation", enabled: false },
    ]);
  });

  it("replaces the entry of a trigger that was sent, with the canonical key", async () => {
    const w = world(structuredClone(FULL));
    await updateAgentSettings(context(), { handoffTriggers: [{ key: "kb_gap", enabled: true }] }, w.deps);
    const triggers = w.stored().handoffTriggers as { key: string; enabled: boolean }[];
    expect(triggers.filter((t) => t.key === "kb_gap")).toEqual([{ key: "kb_gap", enabled: true }]);
    expect(triggers).toHaveLength(2);
  });

  it("replaces an alias entry (`gap`, `human`, `price_negotiation`, `hot`) so the two cannot disagree, and the agent reads what was sent", async () => {
    const aliases = { kb_gap: "gap", asked_human: "human", negotiation: "price_negotiation", hot_lead: "hot" } as const;
    for (const [key, alias] of Object.entries(aliases)) {
      const w = world({ handoffTriggers: [{ key: alias, enabled: false }] });
      await updateAgentSettings(context(), { handoffTriggers: [{ key: key as keyof typeof aliases, enabled: true }] }, w.deps);
      expect(w.stored().handoffTriggers).toEqual([{ key, enabled: true }]);
      const reading = parseReplySettings(w.stored());
      expect({ kb_gap: reading.kbGapHandoffEnabled, asked_human: reading.askedHumanHandoffEnabled, negotiation: reading.negotiationHandoffEnabled, hot_lead: reading.hotLeadAlertEnabled }[key]).toBe(true);
    }
  });

  it("keeps the alias names the agent understands in step with what the agent reads (persona.ts)", () => {
    for (const trigger of HANDOFF_TRIGGERS) {
      for (const key of [trigger.key, ...trigger.aliases]) {
        const reading = parseReplySettings({ handoffTriggers: [{ key, enabled: false }] });
        const off = [reading.kbGapHandoffEnabled, reading.askedHumanHandoffEnabled, reading.complaintHandoffEnabled, reading.negotiationHandoffEnabled, reading.hotLeadAlertEnabled].filter((on) => !on);
        expect(off, `${key} should switch exactly one thing off in persona.ts`).toHaveLength(1);
      }
    }
  });

  it("starts the list when none was stored, and drops nothing when the stored list has entries it does not know", async () => {
    const empty = world({});
    await updateAgentSettings(context(), { handoffTriggers: [{ key: "kb_gap", enabled: false }] }, empty.deps);
    expect(empty.stored().handoffTriggers).toEqual([{ key: "kb_gap", enabled: false }]);
    const odd = world({ handoffTriggers: [{ key: "stuck", enabled: false }, "junk", 5] });
    await updateAgentSettings(context(), { handoffTriggers: [{ key: "kb_gap", enabled: false }] }, odd.deps);
    expect(odd.stored().handoffTriggers).toEqual([{ key: "stuck", enabled: false }, "junk", 5, { key: "kb_gap", enabled: false }]);
  });

  it("answers the settings as they now stand", async () => {
    const view = await updateAgentSettings(context(), { tone: "formal", persona: "Ravi", handoffTriggers: [{ key: "complaint", enabled: false }] }, world({}).deps);
    expect(view).toMatchObject({ tone: "formal", persona: "Ravi" });
    expect(view.handoffTriggers.find((t) => t.key === "complaint")?.enabled).toBe(false);
  });

  it.each([[[]], ["text"], [7], [true]])("refuses to overwrite a stored value that is not an object (%j): a conflict, and nothing is written", async (odd) => {
    const w = world(odd);
    const error = await failure(updateAgentSettings(context(), { tone: "formal" }, w.deps));
    expect(error.code).toBe("conflict");
    expect(error.message).toMatch(/nothing was changed/i);
    expect(w.calls.filter((c) => c.op !== "select")).toEqual([]);
    expect(w.tables.tenants[0].agent_settings).toEqual(odd);
  });

  it("treats a missing value (null) as an empty object", async () => {
    const w = world(null);
    await updateAgentSettings(context(), { tone: "formal" }, w.deps);
    expect(w.stored()).toEqual({ tone: "formal" });
  });

  it("does not write, and does not audit, when the change leaves everything as it was", async () => {
    const w = world(structuredClone(FULL));
    const view = await updateAgentSettings(context(), { tone: "formal", privacyNotice: true, persona: "Priya", handoffTriggers: [{ key: "kb_gap", enabled: false }] }, w.deps);
    expect(view.tone).toBe("formal");
    expect(w.calls.filter((c) => c.op !== "select")).toEqual([]);
    expect(w.audit).not.toHaveBeenCalled();
  });
});

describe("PATCH: the booking service", () => {
  it("must be an active service of the caller's own business", async () => {
    const w = world({});
    await updateAgentSettings(context(), { bookingServiceId: SITE_VISIT }, w.deps);
    expect(w.stored().bookingServiceId).toBe(SITE_VISIT);
  });

  it.each([
    ["a service that is switched off", OFF_SERVICE],
    ["a service of another business", FOREIGN_SERVICE],
    ["an id that is no service at all", "d6000000-0000-4000-8000-0000000000ff"],
  ])("refuses %s, with a field error, and writes nothing", async (_name, id) => {
    const w = world({ tone: "friendly" });
    const error = await failure(updateAgentSettings(context(), { bookingServiceId: id }, w.deps));
    expect(error.code).toBe("validation_failed");
    expect(error.fields?.bookingServiceId).toMatch(/active service/i);
    expect(w.calls.filter((c) => c.op !== "select")).toEqual([]);
    expect(w.audit).not.toHaveBeenCalled();
  });

  it("is checked against the business of the session, never one named in the request", async () => {
    const w = world({});
    await failure(updateAgentSettings(context("owner", B), { bookingServiceId: SITE_VISIT }, w.deps)); // A's service, B's session
    expect(w.tables.tenants[1].agent_settings).toEqual({ persona: "Other Biz", tone: "formal" });
    const serviceCall = w.calls.find((c) => c.table === "services");
    expect(serviceCall?.filters).toEqual(expect.arrayContaining([{ column: "tenant_id", value: B }]));
  });

  it("clearing it needs no check", async () => {
    const w = world({ bookingServiceId: OFF_SERVICE });
    await updateAgentSettings(context(), { bookingServiceId: null }, w.deps);
    expect(w.stored()).toEqual({});
    expect(w.calls.some((c) => c.table === "services")).toBe(false);
  });
});

describe("PATCH: one business never touches another", () => {
  it("writes only the caller's row, and names the business on every query", async () => {
    const w = world({ tone: "friendly" });
    await updateAgentSettings(context("owner", A), { tone: "formal", bookingServiceId: SITE_VISIT, persona: "Ravi" }, w.deps);
    expect(w.otherStored()).toEqual({ persona: "Other Biz", tone: "formal" });
    for (const call of w.calls) {
      expect(call.filters.some((f) => (f.column === "id" || f.column === "tenant_id") && f.value === A), `${call.table} ${call.op} is not scoped to the business`).toBe(true);
    }
  });

  it("the same change for the other business leaves the first untouched", async () => {
    const w = world({ persona: "Mine", tone: "friendly" });
    await updateAgentSettings(context("owner", B), { tone: "friendly", persona: "Theirs" }, w.deps);
    expect(w.stored()).toEqual({ persona: "Mine", tone: "friendly" });
    expect(w.otherStored()).toEqual({ persona: "Theirs", tone: "friendly" });
  });

  it("a business that does not exist is not_found, and nothing is written", async () => {
    const w = world({});
    const error = await failure(updateAgentSettings(context("owner", "e0000000-0000-4000-8000-0000000000ff"), { tone: "formal" }, w.deps));
    expect(error.code).toBe("not_found");
    expect(w.calls.filter((c) => c.op !== "select")).toEqual([]);
  });
});

describe("PATCH: two writers at once", () => {
  it("notices a change made between the read and the write, and applies the change on top of it", async () => {
    // Someone else sets the persona just after we read and just before we write: the first write must not overwrite it.
    const w = world({ tone: "friendly" }, { beforeTenantUpdate: (n, tables) => { if (n === 1) tables.tenants[0].agent_settings = { tone: "friendly", persona: "Added by someone else" }; } });
    await updateAgentSettings(context(), { tone: "formal" }, w.deps);
    expect(w.stored()).toEqual({ tone: "formal", persona: "Added by someone else" });
    expect(w.calls.filter((c) => c.op === "update")).toHaveLength(2);
  });

  it("when the other writer already made the same change, the retry finds nothing left to do, and keeps their other changes", async () => {
    const w = world({ tone: "friendly", privacyNotice: true }, { beforeTenantUpdate: (n, tables) => { if (n === 1) tables.tenants[0].agent_settings = { tone: "formal", privacyNotice: false }; } });
    await updateAgentSettings(context(), { tone: "formal" }, w.deps);
    expect(w.stored()).toEqual({ tone: "formal", privacyNotice: false });
    expect(w.calls.filter((c) => c.op === "update")).toHaveLength(1);
    expect(w.audit).not.toHaveBeenCalled();
  });

  it("gives up after three tries with a conflict that says nothing was changed by this request, and writes no audit row", async () => {
    let n = 0;
    const w = world({ tone: "friendly" }, { beforeTenantUpdate: (_n, tables) => { tables.tenants[0].agent_settings = { tone: "friendly", counter: ++n }; } });
    const error = await failure(updateAgentSettings(context(), { tone: "formal" }, w.deps));
    expect(error.code).toBe("conflict");
    expect(error.message).toMatch(/someone else/i);
    expect(w.calls.filter((c) => c.op === "update")).toHaveLength(3);
    expect(w.stored().tone).toBe("friendly");
    expect(w.audit).not.toHaveBeenCalled();
  });

  it("compares the whole stored value by content, so a different key order is the same value", async () => {
    const w = world({ tone: "formal", persona: "Priya" });
    w.tables.tenants[0].agent_settings = { persona: "Priya", tone: "formal" };
    await updateAgentSettings(context(), { privacyNotice: true }, w.deps);
    expect(w.stored()).toEqual({ persona: "Priya", tone: "formal", privacyNotice: true });
    expect(w.calls.filter((c) => c.op === "update")).toHaveLength(1);
  });
});

describe("PATCH: the audit row", () => {
  it("records who changed what: the keys, and the old and new values of the ones that are not text", async () => {
    const w = world({ tone: "friendly", privacyNotice: false, persona: "Priya", handoffTriggers: [{ key: "kb_gap", enabled: true }] });
    await updateAgentSettings(
      context("admin"),
      { tone: "formal", privacyNotice: true, persona: "Ravi", bookingServiceId: SITE_VISIT, handoffTriggers: [{ key: "kb_gap", enabled: false }, { key: "complaint", enabled: true }] },
      w.deps,
    );
    expect(w.audit).toHaveBeenCalledTimes(1);
    expect(w.audit).toHaveBeenCalledWith({
      tenantId: A,
      actor: USER,
      action: "agent_settings.updated",
      entity: "tenant",
      entityId: A,
      diff: {
        changed: ["bookingServiceId", "handoffTriggers", "persona", "privacyNotice", "tone"],
        tone: { from: "friendly", to: "formal" },
        privacyNotice: { from: false, to: true },
        bookingServiceId: { from: null, to: SITE_VISIT },
        handoffTriggers: { kb_gap: { from: true, to: false } },
      },
    });
  });

  it("never holds the persona's text (a name is customer-facing text, like the settings text 0049 also leaves out)", async () => {
    const w = world({ persona: "Priya" });
    await updateAgentSettings(context(), { persona: "Ravi Kumar" }, w.deps);
    const entry = JSON.stringify(w.audit.mock.calls[0]);
    expect(entry).not.toMatch(/Ravi|Priya/);
    expect(entry).toContain('"changed":["persona"]');
  });

  it("holds only the keys that changed", async () => {
    const w = world({ tone: "friendly", privacyNotice: true });
    await updateAgentSettings(context(), { tone: "formal", privacyNotice: true }, w.deps);
    const diff = (w.audit.mock.calls[0] as unknown as [{ diff: Record<string, unknown> }])[0].diff;
    expect(diff.changed).toEqual(["tone"]);
    expect(diff).not.toHaveProperty("privacyNotice");
  });

  it("is written after the change, and a failure to write it is logged and does not undo or fail the change", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({});
    w.deps.audit = vi.fn(async () => {
      throw new Error("audit down");
    });
    await expect(updateAgentSettings(context(), { tone: "formal" }, w.deps)).resolves.toMatchObject({ tone: "formal" });
    expect(w.stored().tone).toBe("formal");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("when the database fails", () => {
  it.each(["error", "throw"] as const)("a failed read (%s) is an error, and nothing is written", async (mode) => {
    const w = world({}, { fail: ({ table, op }) => (table === "tenants" && op === "select" ? mode : undefined) });
    await expect(updateAgentSettings(context(), { tone: "formal" }, w.deps)).rejects.toThrow();
    expect(w.calls.filter((c) => c.op !== "select")).toEqual([]);
    await expect(getAgentSettings(context(), w.deps)).rejects.toThrow();
  });

  it.each(["error", "throw"] as const)("a failed write (%s) is an error, with no audit row", async (mode) => {
    const w = world({ tone: "friendly" }, { fail: ({ table, op }) => (table === "tenants" && op === "update" ? mode : undefined) });
    await expect(updateAgentSettings(context(), { tone: "formal" }, w.deps)).rejects.toThrow();
    expect(w.audit).not.toHaveBeenCalled();
    expect(w.stored()).toEqual({ tone: "friendly" });
  });

  it("the error says the database's code at most, never the settings", async () => {
    const w = world({ persona: "Priya" }, { fail: ({ table, op }) => (table === "tenants" && op === "update" ? "error" : undefined) });
    const error = (await updateAgentSettings(context(), { persona: "Ravi" }, w.deps).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toMatch(/Ravi|Priya/);
  });
});

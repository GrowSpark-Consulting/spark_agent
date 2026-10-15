import { describe, expect, it } from "vitest";
import {
  AGENT_PERSONA_MAX_LENGTH,
  AGENT_TRIGGER_KEYS,
  AgentSettings,
  AgentTone,
  AgentTriggerChanges,
  UpdateAgentSettings,
  type AgentSettings as AgentSettingsType,
  type UpdateAgentSettings as UpdateAgentSettingsType,
} from "./agent-settings";

// The Agent settings contract (GET and PATCH /api/agent/settings, backend/src/agent/settings/agent-settings.ts): the answer the screen reads and the body it
// sends. The backend builds its checks from the same field schemas and types its answer with AgentSettings, so the two cannot drift.

const SERVICE = "d6000000-0000-4000-8000-000000000011";

const row = (key: string, enabled = true) => ({ key, label: "A label", example: "An example", highPriority: false, enabled });

describe("the five triggers a business can switch", () => {
  it("are kb_gap, asked_human, complaint, negotiation and hot_lead, in the order the screen shows them", () => {
    expect([...AGENT_TRIGGER_KEYS]).toEqual(["kb_gap", "asked_human", "complaint", "negotiation", "hot_lead"]);
  });
});

describe("AgentSettings, the answer of GET and PATCH", () => {
  const settings: AgentSettingsType = {
    persona: "Priya",
    tone: "formal",
    privacyNotice: true,
    bookingServiceId: SERVICE,
    handoffTriggers: AGENT_TRIGGER_KEYS.map((key) => row(key)) as AgentSettingsType["handoffTriggers"],
  };

  it("accepts the shape the route answers", () => {
    expect(AgentSettings.parse(settings)).toEqual(settings);
  });

  it("allows no persona and no booking service (null)", () => {
    expect(AgentSettings.safeParse({ ...settings, persona: null, bookingServiceId: null }).success).toBe(true);
  });

  it.each([
    ["a tone it does not have", { tone: "warm" }],
    ["a privacy notice that is not a boolean", { privacyNotice: "yes" }],
    ["a persona that is not text", { persona: 5 }],
    ["a missing tone", { tone: undefined }],
    ["a trigger the business cannot switch", { handoffTriggers: [row("stuck")] }],
  ])("refuses %s", (_name, change) => {
    expect(AgentSettings.safeParse({ ...settings, ...change }).success).toBe(false);
  });
});

describe("UpdateAgentSettings, the body of PATCH", () => {
  const ok = (body: unknown) => UpdateAgentSettings.safeParse(body).success;

  it("takes any of the five settings, one or several", () => {
    const body: UpdateAgentSettingsType = { persona: "Ravi", tone: "friendly", privacyNotice: false, bookingServiceId: SERVICE, handoffTriggers: [{ key: "kb_gap", enabled: false }] };
    expect(UpdateAgentSettings.parse(body)).toEqual(body);
    for (const key of Object.keys(body) as (keyof typeof body)[]) expect(ok({ [key]: body[key] })).toBe(true);
  });

  it("allows null for the persona and the booking service (it clears them)", () => {
    expect(ok({ persona: null })).toBe(true);
    expect(ok({ bookingServiceId: null })).toBe(true);
  });

  it("needs at least one setting, and refuses any key that is not one", () => {
    expect(ok({})).toBe(false);
    expect(ok({ tone: "formal", tenantId: SERVICE })).toBe(false);
    expect(ok({ languages: ["en"] })).toBe(false);
  });

  it.each([
    ["a tone it does not have", { tone: "warm" }],
    ["a privacy notice that is not a boolean", { privacyNotice: 1 }],
    ["a booking service that is not an id", { bookingServiceId: "service-1" }],
    ["no triggers", { handoffTriggers: [] }],
    ["a trigger that cannot be switched (stuck, opt_out, credits_exhausted)", { handoffTriggers: [{ key: "stuck", enabled: false }] }],
    ["an alias of a trigger (it is read, never written)", { handoffTriggers: [{ key: "gap", enabled: false }] }],
    ["a trigger with no enabled", { handoffTriggers: [{ key: "kb_gap" }] }],
    ["a trigger with a key it should not have", { handoffTriggers: [{ key: "kb_gap", enabled: false, label: "x" }] }],
    ["the same trigger twice", { handoffTriggers: [{ key: "kb_gap", enabled: false }, { key: "kb_gap", enabled: true }] }],
  ])("refuses %s", (_name, body) => {
    expect(ok(body)).toBe(false);
  });

  it("sends only the triggers that changed, each once, over the five keys", () => {
    expect(AgentTriggerChanges.safeParse(AGENT_TRIGGER_KEYS.map((key) => ({ key, enabled: false }))).success).toBe(true);
    expect(AgentTriggerChanges.safeParse([...AGENT_TRIGGER_KEYS, "kb_gap"].map((key) => ({ key, enabled: false }))).success).toBe(false);
  });

  it("leaves the persona's wording rules to the server: any text or null passes here", () => {
    expect(ok({ persona: "x".repeat(AGENT_PERSONA_MAX_LENGTH + 20) })).toBe(true);
    expect(AGENT_PERSONA_MAX_LENGTH).toBe(30);
  });

  it("knows the two tones", () => {
    expect(AgentTone.options).toEqual(["friendly", "formal"]);
  });
});

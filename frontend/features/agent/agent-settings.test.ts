import { readFileSync } from "node:fs";
import { AGENT_TRIGGER_KEYS, type AgentSettings } from "@pakka/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

const getJson = vi.fn();
const patchJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ getJson: (...a: unknown[]) => getJson(...a), patchJson: (...a: unknown[]) => patchJson(...a) }));

const { AgentSettingsDataError, agentSettingsService, canEditAgentSettings, canSave, changedFields, draftFrom, personaValue, saveFailure } = await import("./agent-settings");

// The shapes are the backend's own (packages/types/src/agent-settings.ts), typed here so a field the contract drops fails the typecheck. These tests
// stand in for the API: they prove what this code sends and how it reads each answer, not that the real route agrees.

const TENANT = "10000000-0000-0000-0000-000000000004";
const SERVICE = "11111111-1111-4111-8111-111111111111";
const row = (key: (typeof AGENT_TRIGGER_KEYS)[number], enabled = true) => ({ key, label: `Label ${key}`, example: `Example ${key}`, highPriority: key === "complaint", enabled });
const server = (over: Partial<AgentSettings> = {}): AgentSettings => ({
  persona: "Maya",
  tone: "friendly",
  privacyNotice: false,
  bookingServiceId: SERVICE,
  handoffTriggers: AGENT_TRIGGER_KEYS.map((k) => row(k)),
  ...over,
});
const apiError = (status: number, code: string, message = "m", fields?: Record<string, string>) => new ApiError(status, { error: { code, message, ...(fields && { fields }) } } as never);

beforeEach(() => {
  getJson.mockReset();
  patchJson.mockReset();
});

describe("GET /api/agent/settings", () => {
  it("reads the documented path for the business and returns the settings with the server's labels, examples and priorities", async () => {
    getJson.mockResolvedValue(server());
    const settings = await agentSettingsService.load(TENANT);
    expect(getJson.mock.calls[0][0]).toBe("/api/agent/settings");
    expect(getJson.mock.calls[0][1]).toMatchObject({ tenantId: TENANT });
    expect(settings.handoffTriggers.map((t) => t.key)).toEqual([...AGENT_TRIGGER_KEYS]);
    expect(settings.handoffTriggers[2]).toMatchObject({ label: "Label complaint", example: "Example complaint", highPriority: true });
  });

  it("takes a null persona and a privacy notice that is off as the server's own values", async () => {
    getJson.mockResolvedValue(server({ persona: null, privacyNotice: false }));
    expect(draftFrom(await agentSettingsService.load(TENANT))).toMatchObject({ persona: "", privacyNotice: false });
  });

  it("refuses an answer that is not the contract's shape, rather than drawing part of it", async () => {
    for (const bad of [{ ...server(), tone: "warm" }, { ...server(), handoffTriggers: [row("kb_gap"), { ...row("kb_gap"), key: "stuck" }] }, [], null, "ok"]) {
      getJson.mockResolvedValueOnce(bad);
      await expect(agentSettingsService.load(TENANT)).rejects.toBeInstanceOf(AgentSettingsDataError);
    }
  });

  it("passes a server refusal on unchanged", async () => {
    getJson.mockRejectedValue(apiError(500, "internal"));
    await expect(agentSettingsService.load(TENANT)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("PATCH /api/agent/settings", () => {
  it("sends exactly the body it is given, to the documented path, and returns the settings as the server answers", async () => {
    const saved = server({ tone: "formal" });
    patchJson.mockResolvedValue(saved);
    expect(await agentSettingsService.update(TENANT, { tone: "formal" })).toEqual(saved);
    expect(patchJson).toHaveBeenCalledWith("/api/agent/settings", { tone: "formal" }, { tenantId: TENANT });
  });

  it("sends nothing the contract would refuse: an empty change, an unknown key, a business, a stuck handover", async () => {
    for (const bad of [{}, { language: "ta" }, { tenantId: TENANT }, { handoffTriggers: [{ key: "stuck", enabled: false }] }, { handoffTriggers: [] }]) {
      await expect(agentSettingsService.update(TENANT, bad as never)).rejects.toBeInstanceOf(AgentSettingsDataError);
    }
    expect(patchJson).not.toHaveBeenCalled();
  });

  it("does not take an unreadable answer for a saved one", async () => {
    patchJson.mockResolvedValue({ ok: true });
    await expect(agentSettingsService.update(TENANT, { privacyNotice: true })).rejects.toBeInstanceOf(AgentSettingsDataError);
  });
});

describe("persona", () => {
  it("is tidied the way the server tidies it, and empty means no name", () => {
    expect(personaValue("  Priya   Rao ")).toBe("Priya Rao");
    expect(personaValue("")).toBeNull();
    expect(personaValue("   ")).toBeNull();
  });

  it("allows 30 characters and reports 31 instead of cutting it", () => {
    const s = server();
    expect(changedFields(s, { ...draftFrom(s), persona: "a".repeat(30) })).toMatchObject({ patch: { persona: "a".repeat(30) }, errors: {} });
    const long = changedFields(s, { ...draftFrom(s), persona: "a".repeat(31) });
    expect(long.errors.persona).toMatch(/30/);
    expect("persona" in long.patch).toBe(false);
  });

  it("leaves the wording rule (letters, numbers, spaces and . ' & -) to the server", () => {
    const s = server();
    expect(changedFields(s, { ...draftFrom(s), persona: "Maya #1!" }).patch).toEqual({ persona: "Maya #1!" });
  });
});

describe("what a save sends", () => {
  it("sends nothing when nothing changed, even if the persona only differs by spaces", () => {
    const s = server();
    expect(changedFields(s, draftFrom(s)).patch).toEqual({});
    expect(changedFields(s, { ...draftFrom(s), persona: "  Maya " }).patch).toEqual({});
  });

  it("sends only the field that changed", () => {
    const s = server();
    expect(changedFields(s, { ...draftFrom(s), tone: "formal" }).patch).toEqual({ tone: "formal" });
    expect(changedFields(s, { ...draftFrom(s), privacyNotice: true }).patch).toEqual({ privacyNotice: true });
    expect(changedFields(s, { ...draftFrom(s), persona: "Priya" }).patch).toEqual({ persona: "Priya" });
  });

  it("clearing the name sends null; clearing a name that was never set sends nothing", () => {
    expect(changedFields(server(), { ...draftFrom(server()), persona: "" }).patch).toEqual({ persona: null });
    const none = server({ persona: null });
    expect(changedFields(none, { ...draftFrom(none), persona: "" }).patch).toEqual({});
  });

  it("sends only the handovers that changed, as { key, enabled } and nothing else, and never the booking service", () => {
    const s = server();
    const draft = draftFrom(s);
    draft.triggers = { ...draft.triggers, complaint: false, hot_lead: false };
    const { patch } = changedFields(s, draft);
    expect(patch).toEqual({
      handoffTriggers: [
        { key: "complaint", enabled: false },
        { key: "hot_lead", enabled: false },
      ],
    });
    expect(JSON.stringify(patch)).not.toMatch(/label|example|highPriority/);
    expect("bookingServiceId" in patch).toBe(false);
  });

  it("switching a handover off and on again sends nothing", () => {
    const s = server();
    const draft = draftFrom(s);
    draft.triggers.kb_gap = false;
    draft.triggers.kb_gap = true;
    expect(changedFields(s, draft).patch).toEqual({});
  });

  it("a change the form can see is wrong is reported and left out, while the rest still goes", () => {
    const s = server();
    const result = changedFields(s, { ...draftFrom(s), persona: "x".repeat(40), tone: "formal" });
    expect(result.errors.persona).toBeDefined();
    expect(result.patch).toEqual({ tone: "formal" });
  });
});

describe("who can save", () => {
  const changes = { patch: { tone: "formal" as const }, errors: {} };
  it("owner and admin can; staff and a missing role cannot", () => {
    expect(canEditAgentSettings("owner")).toBe(true);
    expect(canEditAgentSettings("admin")).toBe(true);
    expect(canSave("owner", changes, false)).toBe(true);
    expect(canSave("admin", changes, false)).toBe(true);
    expect(canSave("staff", changes, false)).toBe(false);
    expect(canSave(null, changes, false)).toBe(false);
  });

  it("is off with nothing changed, with a problem in the form, and while a save is in flight", () => {
    expect(canSave("owner", { patch: {}, errors: {} }, false)).toBe(false);
    expect(canSave("owner", { ...changes, errors: { persona: "too long" } }, false)).toBe(false);
    expect(canSave("owner", changes, true)).toBe(false);
  });
});

describe("how a refusal reads", () => {
  it("401: signed out, nothing saved, the changes are still there", () => {
    expect(saveFailure(apiError(401, "unauthenticated")).message).toMatch(/signed out.*nothing was saved/i);
  });

  it("403 (staff) and no business: only an owner or admin, nothing saved", () => {
    for (const code of ["forbidden", "no_membership"]) expect(saveFailure(apiError(403, code)).message).toMatch(/only an owner or admin/i);
  });

  it("409: changed elsewhere, nothing saved, and offers to load the current settings", () => {
    const failure = saveFailure(apiError(409, "conflict"));
    expect(failure.stale).toBe(true);
    expect(failure.message).toMatch(/nothing was saved/i);
  });

  it("422: keeps the field names the server sent so each can be shown beside its box", () => {
    const failure = saveFailure(apiError(422, "validation_failed", "Check the fields", { persona: "Use 30 characters or fewer: a name, not a sentence.", bookingServiceId: "That isn't an active service of your business." }));
    expect(failure.fields.persona).toMatch(/30 characters/);
    expect(failure.fields.bookingServiceId).toBeDefined();
    expect(failure.message).toMatch(/nothing was saved/i);
    expect(failure.stale).toBe(false);
  });

  it("a server failure or no network says nothing was saved and is not a conflict", () => {
    expect(saveFailure(apiError(500, "internal", "Something went wrong")).message).toMatch(/^Nothing was saved\./);
    expect(saveFailure(new TypeError("fetch failed")).message).toMatch(/^Nothing was saved\./);
    expect(saveFailure(new TypeError("fetch failed")).stale).toBe(false);
  });

  it("an answer it cannot read does NOT say nothing was saved: the server may have saved", () => {
    const failure = saveFailure(new AgentSettingsDataError());
    expect(failure.message).not.toMatch(/nothing was saved/i);
    expect(failure.stale).toBe(true);
  });
});

describe("no direct database writes for these settings", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  it.each(["./agent-settings.ts", "./agent-settings-screen.tsx"])("%s never touches Supabase", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/supabase/i);
    expect(source).not.toMatch(/\.from\(["'`]|\.rpc\(/);
  });
  it("the settings go to the API client only", () => {
    expect(read("./agent-settings.ts")).toMatch(/from "@\/lib\/api\/client"/);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_NUDGE_TIMING } from "../leads/nudges";
import { FEATURE_SETTINGS, mergeSettings } from "./settings";

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as { code: string; message: string; fields?: Record<string, string> };
  }
  throw new Error("expected the settings to be refused");
};

describe("feature settings", () => {
  it("accepts what each job reads, including the jobs' own defaults", () => {
    expect(mergeSettings("reminder_24h", {}, { offset_minutes: 1440 })).toEqual({ offset_minutes: 1440 });
    expect(mergeSettings("reminder_2h", {}, { offset_minutes: 120 })).toEqual({ offset_minutes: 120 });
    expect(mergeSettings("feedback_request", {}, { offset_minutes: 0 })).toEqual({ offset_minutes: 0 });
    expect(mergeSettings("review_request", {}, { review_url: "https://g.page/r/abc" })).toEqual({ review_url: "https://g.page/r/abc" });
    expect(
      mergeSettings("followup_nudges", {}, { offset_minutes: DEFAULT_NUDGE_TIMING.offsetMinutes, nurture_after_minutes: DEFAULT_NUDGE_TIMING.nurtureAfterMinutes }),
    ).toEqual({ offset_minutes: [120, 1380], nurture_after_minutes: 2880 });
    expect(mergeSettings("handoff_triggers", {}, { sla_minutes: 15 })).toEqual({ sla_minutes: 15 });
    expect(mergeSettings("handoff_own_number", {}, { outcome_after_minutes: 240 })).toEqual({ outcome_after_minutes: 240 });
  });

  it("merges into the saved settings, and a key sent as null is removed", () => {
    expect(mergeSettings("followup_nudges", { offset_minutes: [60, 600], nurture_after_minutes: 2880 }, { nurture_after_minutes: 1440 })).toEqual({
      offset_minutes: [60, 600],
      nurture_after_minutes: 1440,
    });
    expect(mergeSettings("review_request", { review_url: "https://g.page/r/abc" }, { review_url: null })).toEqual({});
  });

  it("refuses what a job would quietly ignore, saying what is expected", () => {
    const tooBig = refused(() => mergeSettings("reminder_24h", {}, { offset_minutes: 20_000 }));
    expect(tooBig.code).toBe("validation_failed");
    expect(tooBig.fields?.settings).toMatch(/from 1 to 10080/);
    // The nudge job reads both keys together or neither.
    expect(refused(() => mergeSettings("followup_nudges", {}, { nurture_after_minutes: 2880 })).message).toMatch(/sent together/);
    expect(refused(() => mergeSettings("followup_nudges", {}, { offset_minutes: [600, 60], nurture_after_minutes: 2880 })).code).toBe("validation_failed");
    expect(refused(() => mergeSettings("review_request", {}, { review_url: "http://g.page/r/abc" })).message).toMatch(/https/);
    expect(refused(() => mergeSettings("review_request", {}, { review_url: `https://example.com/${"x".repeat(500)}` })).code).toBe("validation_failed");
  });

  it("refuses unknown keys, and any settings on a feature that has none", () => {
    expect(refused(() => mergeSettings("reminder_24h", {}, { offset_minutes: 60, colour: "red" })).message).toMatch(/^colour is not a setting/);
    expect(refused(() => mergeSettings("ai_auto_reply", {}, { tone: "formal" })).message).toBe("This feature has no settings.");
    expect(refused(() => mergeSettings("__proto__", {}, { a: 1 })).message).toBe("This feature has no settings.");
  });

  it("lets a feature with no settings stay empty", () => {
    expect(mergeSettings("ai_auto_reply", {}, {})).toEqual({});
    expect(Object.keys(FEATURE_SETTINGS).sort()).toEqual(
      ["feedback_request", "followup_nudges", "handoff_own_number", "handoff_triggers", "reminder_24h", "reminder_2h", "review_request"].sort(),
    );
  });
});

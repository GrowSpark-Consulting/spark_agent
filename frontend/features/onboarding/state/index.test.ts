import { describe, expect, it } from "vitest";
import { trialChatUrl } from "@/features/onboarding/data";
import { initialState, testChatOf, phoneProblem, trialCodeOf, trialPhoneOf, type OnboardingState } from "@/features/onboarding/state";

const TRIAL = { routeCode: "TRIAL-AB12", trialDays: 7, credits: 300 };
const withTrial: OnboardingState = { ...initialState, trial: TRIAL };
const NUMBER = "15555550100"; // a fictional test number, not a real one

describe("trialChatUrl", () => {
  it("builds the wa.me link from the configured number and the backend's route code", () => {
    expect(trialChatUrl(NUMBER, "TRIAL-AB12")).toBe("https://wa.me/15555550100?text=TRIAL-AB12");
  });

  it("URL-encodes the code", () => {
    expect(trialChatUrl(NUMBER, "DEMO SALON&x=1")).toBe("https://wa.me/15555550100?text=DEMO%20SALON%26x%3D1");
  });

  it("is null without a number, with an invalid one, or without a code", () => {
    expect(trialChatUrl(null, "TRIAL-AB12")).toBeNull();
    expect(trialChatUrl("919000000000x", "TRIAL-AB12")).toBeNull();
    expect(trialChatUrl("0123456789", "TRIAL-AB12")).toBeNull();
    expect(trialChatUrl(NUMBER, null)).toBeNull();
    expect(trialChatUrl(NUMBER, "  ")).toBeNull();
  });
});

describe("trialCodeOf", () => {
  it("is the backend's route code, and never a sample code", () => {
    expect(trialCodeOf(withTrial)).toBe("TRIAL-AB12");
    expect(trialCodeOf(initialState)).toBeNull();
  });
});

describe("testChatOf", () => {
  it("offers the link only for a real trial and a configured number", () => {
    expect(testChatOf(withTrial, NUMBER)).toEqual({ kind: "ready", code: "TRIAL-AB12", url: "https://wa.me/15555550100?text=TRIAL-AB12" });
  });

  it("shows the real code but no link when the demo number is missing or invalid", () => {
    expect(testChatOf(withTrial, null)).toEqual({ kind: "unavailable", code: "TRIAL-AB12" });
  });

  it("shows nothing for an account that already has a business, even with a number configured", () => {
    expect(testChatOf({ ...initialState, hasBusiness: true }, NUMBER)).toEqual({ kind: "none", reason: "has_business" });
  });

  it("keeps the trial this session created when a repeat submit then finds the business", () => {
    expect(testChatOf({ ...withTrial, hasBusiness: true }, NUMBER)).toMatchObject({ kind: "ready", code: "TRIAL-AB12" });
  });

  it("shows nothing when no trial exists", () => {
    expect(testChatOf(initialState, NUMBER)).toEqual({ kind: "none", reason: "no_trial" });
  });
});

describe("trialPhoneOf", () => {
  const typed = (phone: string): OnboardingState => ({ ...initialState, phone });

  it("sends nothing for the pre-filled sample number", () => {
    expect(trialPhoneOf(initialState)).toBeUndefined();
    expect(trialPhoneOf(typed("+91 98400 12345"))).toBeUndefined();
  });

  it("turns a typed ten-digit Indian mobile number into E.164, however it is spaced or prefixed", () => {
    for (const text of ["98765 43210", "9876543210", "+91 98765 43210", "91 98765-43210", "098765 43210"]) expect(trialPhoneOf(typed(text)), text).toBe("+919876543210");
  });

  it("sends nothing for something that is not a mobile number (the route would only refuse the shape)", () => {
    for (const text of ["", "12345", "5876543210", "98765 4321", "98765 432101", "abc"]) expect(trialPhoneOf(typed(text)), text).toBeUndefined();
  });
});

describe("phoneProblem", () => {
  const typed = (phone: string): OnboardingState => ({ ...initialState, phone });

  it("accepts the pre-filled sample and any usual way of writing a mobile number", () => {
    for (const text of ["98400 12345", "9876543210", "+91 98765 43210", "098765 43210"]) expect(phoneProblem(typed(text)), text).toBeNull();
  });

  it("refuses a missing number", () => {
    for (const text of ["", "   "]) expect(phoneProblem(typed(text)), JSON.stringify(text)).toMatch(/enter your whatsapp number/i);
  });

  it("refuses a number that is not a ten-digit Indian mobile", () => {
    for (const text of ["12345", "5876543210", "98765 4321", "98765 432101", "abc"]) expect(phoneProblem(typed(text)), text).toMatch(/10-digit/);
  });
});

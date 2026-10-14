import { describe, expect, it } from "vitest";
import { fakeDb } from "../test-support/fake-db";
import { claimTrialPhone, trialPhoneHash, trialPhoneUsed } from "./trial-phone";

const TENANT = "2a3b4c5d-6e7f-4801-9a2b-3c4d5e6f7a8b";

describe("claimTrialPhone", () => {
  it("passes the business and the sender to claim_trial_phone and returns its answer", async () => {
    const { client, calls } = fakeDb({ "rpc:claim_trial_phone": { data: "taken", error: null } });
    expect(await claimTrialPhone(TENANT, "919800000601", client)).toBe("taken");
    expect(calls).toEqual([{ table: "rpc:claim_trial_phone", method: "rpc", args: [{ p_tenant_id: TENANT, p_phone: "919800000601" }] }]);
  });

  it("throws when the database refuses the phone", async () => {
    const { client } = fakeDb({
      "rpc:claim_trial_phone": { data: null, error: { code: "P0001", message: "claim_trial_phone: the phone must be a full international number, country code included" } },
    });
    await expect(claimTrialPhone(TENANT, "98000 00601", client)).rejects.toThrow("claim_trial_phone failed: claim_trial_phone: the phone must be");
  });

  it("throws on an answer it does not know rather than routing on it", async () => {
    const { client } = fakeDb({ "rpc:claim_trial_phone": { data: "maybe", error: null } });
    await expect(claimTrialPhone(TENANT, "919800000601", client)).rejects.toThrow();
  });
});

describe("trialPhoneUsed (the wizard's early warning; reads only)", () => {
  it("keys a number by the SHA-256 of its digits, as claim_trial_phone does, whatever the formatting", () => {
    expect(trialPhoneHash("+91 98000 00601")).toBe(trialPhoneHash("919800000601"));
    expect(trialPhoneHash("+919800000601")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finds a claimed number and nothing else", async () => {
    const used = fakeDb({ trial_phones: { data: [{ phone_hash: "x" }], error: null } });
    expect(await trialPhoneUsed("+919800000601", used.client)).toBe(true);
    expect(used.calls).toContainEqual({ table: "trial_phones", method: "eq", args: ["phone_hash", trialPhoneHash("+919800000601")] });
    expect(await trialPhoneUsed("+919800000602", fakeDb({ trial_phones: { data: [], error: null } }).client)).toBe(false);
    await expect(trialPhoneUsed("+919800000603", fakeDb({ trial_phones: { data: null, error: { message: "down" } } }).client)).rejects.toThrow("trial phone check failed");
  });
});

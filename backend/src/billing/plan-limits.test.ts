import { describe, expect, it } from "vitest";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import { assertNumberAvailable, assertSeatAvailable, numberUsage, planLimitError, seatUsage } from "./plan-limits";

const TENANT = "2a3b4c5d-6e7f-4801-9a2b-3c4d5e6f7a8b";
const CONNECTION = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

const plan = (name: string, seats: number, numbers: number): FakeDbResponse => ({ data: { plans: { name, seats, whatsapp_numbers: numbers } }, error: null });
const counted = (count: number): FakeDbResponse => ({ data: null, error: null, count });

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

describe("team seats", () => {
  it("counts the business's members against its plan", async () => {
    const { client, calls } = fakeDb({ tenants: plan("Starter", 2, 1), memberships: counted(1) });
    expect(await seatUsage(TENANT, client)).toEqual({ used: 1, limit: 2, planName: "Starter" });
    expect(calls.filter((c) => c.method === "eq").map((c) => [c.table, ...c.args])).toEqual([
      ["tenants", "id", TENANT],
      ["memberships", "tenant_id", TENANT],
    ]);
    await expect(assertSeatAvailable(TENANT, client)).resolves.toBeUndefined();
  });

  it("refuses a member past the plan's seats, saying how many it includes", async () => {
    const { client } = fakeDb({ tenants: plan("Growth", 5, 1), memberships: counted(5) });
    expect(await refusal(assertSeatAvailable(TENANT, client))).toMatchObject({ code: "seat_limit", message: "Your Growth plan includes 5 team members. Upgrade to add more." });
  });

  it("treats Pro's 999 as unlimited", async () => {
    const { client } = fakeDb({ tenants: plan("Pro", 999, 3), memberships: counted(1200) });
    expect(await seatUsage(TENANT, client)).toMatchObject({ limit: "unlimited" });
    await expect(assertSeatAvailable(TENANT, client)).resolves.toBeUndefined();
  });

  it("does not know a business that does not exist", async () => {
    const { client } = fakeDb({ tenants: { data: null, error: null }, memberships: counted(0) });
    expect((await refusal(seatUsage(TENANT, client))).code).toBe("not_found");
  });
});

describe("WhatsApp numbers", () => {
  it("counts every number that is not disconnected, never our platform numbers, and not the row being reconnected", async () => {
    const { client, calls } = fakeDb({ tenants: plan("Pro", 999, 3), whatsapp_connections: counted(2) });
    expect(await numberUsage(TENANT, CONNECTION, client)).toEqual({ used: 2, limit: 3, planName: "Pro" });
    expect(calls.filter((c) => c.table === "whatsapp_connections" && c.method !== "select").map((c) => [c.method, ...c.args])).toEqual([
      ["eq", "tenant_id", TENANT],
      ["neq", "method", "platform"],
      ["neq", "status", "disconnected"],
      ["neq", "id", CONNECTION],
    ]);
  });

  it("refuses a number past the plan's, saying how to make room", async () => {
    const { client } = fakeDb({ tenants: plan("Starter", 2, 1), whatsapp_connections: counted(1) });
    expect(await refusal(assertNumberAvailable(TENANT, null, client))).toMatchObject({
      code: "plan_required",
      message: "Your Starter plan includes 1 WhatsApp number. Disconnect one, or upgrade to add another.",
    });
    const pro = fakeDb({ tenants: plan("Pro", 999, 3), whatsapp_connections: counted(2) });
    await expect(assertNumberAvailable(TENANT, null, pro.client)).resolves.toBeUndefined();
  });
});

describe("the database's refusal", () => {
  it("becomes the API's answer", () => {
    expect(planLimitError({ code: "PA413", message: "seat_limit: the Trial plan includes 2 team members" })).toMatchObject({ code: "seat_limit" });
    expect(planLimitError({ code: "PA403", message: "whatsapp_number_limit: the Starter plan includes 1 WhatsApp numbers" })).toMatchObject({ code: "plan_required" });
    // PA403 from set_tenant_feature is another refusal, answered where it happens.
    expect(planLimitError({ code: "PA403", message: "set_tenant_feature: x is not in this business's plan" })).toBeNull();
    expect(planLimitError({ code: "23505", message: "duplicate key" })).toBeNull();
  });
});

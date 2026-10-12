import { describe, expect, it } from "vitest";
import { fakeDb } from "../test-support/fake-db";
import { alertLevel, loadCreditState } from "./credit-alerts";

const TENANT = "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d";

describe("alertLevel", () => {
  it("is low at a fifth of the plan's monthly credits (80% used), and used up at none", () => {
    expect(alertLevel(1201, 1500)).toBeNull();
    expect(alertLevel(301, 1500)).toBeNull();
    expect(alertLevel(300, 1500)).toBe("low");
    expect(alertLevel(1, 1500)).toBe("low");
    expect(alertLevel(0, 1500)).toBe("used_up");
    // The trial's 300: low at 60.
    expect(alertLevel(61, 300)).toBeNull();
    expect(alertLevel(60, 300)).toBe("low");
    // Rolled-over credits above a month never alert.
    expect(alertLevel(2500, 1500)).toBeNull();
  });
});

describe("loadCreditState", () => {
  it("reads the balance, the plan's monthly credits and the newest grant of the business", async () => {
    const { client, calls } = fakeDb({
      tenants: { data: { plans: { monthly_credits: 1500 } }, error: null },
      "rpc:credit_balance": { data: [{ plan: 250, topup: 0, total: 250 }], error: null },
      credit_ledger: { data: [{ id: 42 }], error: null },
    });
    expect(await loadCreditState(TENANT, client)).toEqual({ balance: 250, monthlyCredits: 1500, grantId: 42 });
    expect(calls.find((c) => c.table === "rpc:credit_balance")?.args[0]).toEqual({ p_tenant_id: TENANT });
    const ledger = calls.filter((c) => c.table === "credit_ledger").map((c) => [c.method, ...c.args]);
    expect(ledger).toEqual([
      ["select", "id"],
      ["eq", "tenant_id", TENANT],
      ["gt", "delta", 0],
      ["order", "id", { ascending: false }],
      ["limit", 1],
    ]);
  });

  it("knows a business with no grant yet, and one that is gone", async () => {
    const never = fakeDb({
      tenants: { data: { plans: { monthly_credits: 300 } }, error: null },
      "rpc:credit_balance": { data: [{ plan: 0, topup: 0, total: 0 }], error: null },
      credit_ledger: { data: [], error: null },
    });
    expect(await loadCreditState(TENANT, never.client)).toMatchObject({ balance: 0, grantId: null });
    const gone = fakeDb({
      tenants: { data: null, error: null },
      "rpc:credit_balance": { data: [{ plan: 0, topup: 0, total: 0 }], error: null },
      credit_ledger: { data: [], error: null },
    });
    expect(await loadCreditState(TENANT, gone.client)).toBeNull();
  });
});

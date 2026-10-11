import type { TenantContext } from "@pakka/types";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/errors";
import type { LeadCard } from "./card";
import { getLeadCard } from "./route";

// GET /api/conversations/:id/lead-card: who may ask, which business, what a chat that is not theirs looks like.

const A = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const context = (role: TenantContext["role"]): TenantContext => ({ role, tenant: { id: A, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "growth", trialEndsAt: null } }) as TenantContext;
const card = { need: "x" } as LeadCard;

describe("getLeadCard", () => {
  it.each(["owner", "admin", "staff"] as const)("is for a %s of the business, and asks for the card of the business's own chat", async (role) => {
    const build = vi.fn(async () => card);
    expect(await getLeadCard(context(role), CONV, build)).toBe(card);
    expect(build).toHaveBeenCalledWith(A, CONV);
  });

  it("is a 404 for a chat that is not this business's: nothing says it exists somewhere else", async () => {
    const error = await getLeadCard(context("owner"), CONV, async () => null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "not_found", status: 404 });
  });

  it("is a 404 for an id that is not an id, without asking the database", async () => {
    const build = vi.fn(async () => card);
    await expect(getLeadCard(context("owner"), "not-an-id", build)).rejects.toMatchObject({ code: "not_found" });
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses a role that is not one of the business's (a new role must be thought about, not allowed by default)", async () => {
    const build = vi.fn(async () => card);
    await expect(getLeadCard({ ...context("owner"), role: "viewer" } as unknown as TenantContext, CONV, build)).rejects.toMatchObject({ code: "forbidden" });
    expect(build).not.toHaveBeenCalled();
  });
});

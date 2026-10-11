import type { TenantContext } from "@pakka/types";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/errors";
import type { LeadCard } from "./card";
import { suggestReply } from "./suggest";

// POST /api/conversations/:id/suggest: who may ask, which business, and that only a reply that passed the card's checks is ever suggested.

const A = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const context = (role: TenantContext["role"]): TenantContext => ({ role, tenant: { id: A, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "growth", trialEndsAt: null } }) as TenantContext;
const card = (over: Partial<LeadCard> = {}) => ({ contact: { name: "Anand", phone: "+919812345621", phoneMasked: "+91 98xxx xxx21", language: "ta-en" }, suggestedReply: "Sure, 3pm works. Shall I book it?", aiWritten: true, ...over }) as LeadCard;

describe("suggestReply", () => {
  it.each(["owner", "admin", "staff"] as const)("is for a %s of the business, and asks for the card of the business's own chat", async (role) => {
    const build = vi.fn(async () => card());
    expect(await suggestReply(context(role), CONV, build)).toEqual({ reply: "Sure, 3pm works. Shall I book it?", language: "ta-en", reason: null });
    expect(build).toHaveBeenCalledWith(A, CONV);
  });

  it("says there is no suggestion this time, as a normal answer, when the words were written by code or no reply passed the checks", async () => {
    for (const over of [{ aiWritten: false }, { suggestedReply: null }, { suggestedReply: "" }]) {
      expect(await suggestReply(context("owner"), CONV, async () => card(over))).toEqual({ reply: null, language: "ta-en", reason: "unavailable" });
    }
  });

  it("a code-written card never gives a reply, even if it somehow held one", async () => {
    expect((await suggestReply(context("owner"), CONV, async () => card({ aiWritten: false, suggestedReply: "Hello" }))).reply).toBeNull();
  });

  it("is a 404 for a chat that is not this business's, and for an id that is not an id (without asking the database)", async () => {
    const error = await suggestReply(context("owner"), CONV, async () => null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "not_found", status: 404 });
    const build = vi.fn(async () => card());
    await expect(suggestReply(context("owner"), "not-an-id", build)).rejects.toMatchObject({ code: "not_found" });
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses a role that is not one of the business's", async () => {
    const build = vi.fn(async () => card());
    await expect(suggestReply({ ...context("owner"), role: "viewer" } as unknown as TenantContext, CONV, build)).rejects.toMatchObject({ code: "forbidden" });
    expect(build).not.toHaveBeenCalled();
  });

  it("returns the reply and the language only: nothing else of the card, no phone number", async () => {
    const answer = await suggestReply(context("owner"), CONV, async () => card());
    expect(Object.keys(answer).sort()).toEqual(["language", "reason", "reply"]);
    expect(JSON.stringify(answer)).not.toContain("9812345621");
  });
});

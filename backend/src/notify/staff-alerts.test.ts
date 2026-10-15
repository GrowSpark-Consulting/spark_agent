import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandoffLinkClaims } from "../agent/handoff/token";
import type { LeadCard } from "../agent/leadcard/card";
import { AppError } from "../lib/errors";
import type { send } from "./send";
import { sendStaffAlert, staffAlertContent, staffAlertMessage, staffAlertRecipients, type StaffAlertDeps } from "./staff-alerts";

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const OWNER = "2c4d6e8f-1a3b-4c5d-8e7f-9a0b1c2d3e4f";

type Result = { data: unknown; error: { message: string } | null };
let tables: Record<string, Result>;
const queries: { table: string; op: string; args: unknown[] }[] = [];
const sendMock = vi.fn<typeof send>(async () => ({ status: "sent", messageId: "m", providerMsgId: "wamid", creditsCharged: 0, usedTemplate: false }));

function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "not"]) {
        b[op] = (...args: unknown[]) => {
          queries.push({ table, op, args });
          return b;
        };
      }
      b.maybeSingle = () => Promise.resolve(tables[table]);
      b.then = (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(tables[table]).then(resolve, reject);
      return b;
    },
  } as unknown as SupabaseClient;
}

const deps = (): StaffAlertDeps => ({ db: fakeDb(), appUrl: "https://app.test/", send: sendMock });

beforeEach(() => {
  queries.length = 0;
  sendMock.mockClear();
  tables = {
    memberships: { data: [{ user_id: "b-admin" }, { user_id: "a-owner" }], error: null },
    conversations: { data: { contacts: { name: "Asha  Raman", phone: "+919840012345" } }, error: null },
    tenants: { data: { name: "Skyline Homes" }, error: null },
  };
});

describe("staffAlertRecipients", () => {
  it("are the owners and admins with an alert number", async () => {
    await expect(staffAlertRecipients(TENANT, deps())).resolves.toEqual(["a-owner", "b-admin"]);
    expect(queries).toContainEqual({ table: "memberships", op: "eq", args: ["tenant_id", TENANT] });
    expect(queries).toContainEqual({ table: "memberships", op: "in", args: ["role", ["owner", "admin"]] });
    expect(queries).toContainEqual({ table: "memberships", op: "not", args: ["whatsapp_phone", "is", null] });
  });

  it("can be narrowed to owners, for an escalation", async () => {
    await staffAlertRecipients(TENANT, deps(), ["owner"]);
    expect(queries).toContainEqual({ table: "memberships", op: "in", args: ["role", ["owner"]] });
  });
});

describe("staffAlertContent", () => {
  it("names the customer and links to the chat", async () => {
    await expect(staffAlertContent(TENANT, { kind: "handoff_opened", conversationId: CONVERSATION }, deps())).resolves.toEqual({
      headline: "Asha Raman is waiting for a person on WhatsApp.",
      link: `https://app.test/dashboard/inbox?chat=${CONVERSATION}`,
    });
    expect(queries).toContainEqual({ table: "conversations", op: "eq", args: ["tenant_id", TENANT] });
  });

  it("masks the number when the chat has no name, and keeps every line Meta-safe", async () => {
    tables.conversations = { data: { contacts: { name: null, phone: "+919840012345" } }, error: null };
    const stuck = await staffAlertContent(TENANT, { kind: "setup_problem", conversationId: CONVERSATION }, deps());
    expect(stuck.headline).toBe("The assistant couldn't continue the chat with +9198xxxxxx45.");
    tables.conversations = { data: { contacts: { name: `A\tvery   long\nname ${"x".repeat(80)}`, phone: "+919840012345" } }, error: null };
    const long = await staffAlertContent(TENANT, { kind: "handoff_opened", conversationId: CONVERSATION }, deps());
    expect(long.headline).not.toMatch(/[\t\n]| {2,}/);
    expect(long.headline.length).toBeLessThan(90);
  });

  it.each([
    ["a link", "Best offers www.cheapflats.in"],
    ["an @", "ravi@example.com"],
    ["a phone number", "Call 98400 12345"],
  ])("shows the masked number instead of a saved name with %s", async (_what, name) => {
    tables.conversations = { data: { contacts: { name, phone: "+919840012345" } }, error: null };
    const alert = await staffAlertContent(TENANT, { kind: "handoff_opened", conversationId: CONVERSATION }, deps());
    expect(alert.headline).toContain("+9198xxxxxx45");
    expect(alert.headline).not.toContain(name);
  });

  it("says how long the customer has waited when no one picked the chat up", async () => {
    await expect(staffAlertContent(TENANT, { kind: "handoff_waiting", conversationId: CONVERSATION, waitedMinutes: 15 }, deps())).resolves.toEqual({
      headline: "Asha Raman has waited 15 minutes and no one has picked up the chat yet.",
      link: `https://app.test/dashboard/inbox?chat=${CONVERSATION}`,
    });
    const one = await staffAlertContent(TENANT, { kind: "handoff_waiting", conversationId: CONVERSATION, waitedMinutes: 1 }, deps());
    expect(one.headline).toContain("waited 1 minute and");
  });

  it("asks the staff member how their own-number chat went", async () => {
    const outcome = await staffAlertContent(TENANT, { kind: "own_number_outcome", conversationId: CONVERSATION }, deps());
    expect(outcome).toEqual({
      headline: "How did your WhatsApp chat with Asha Raman go? Update the lead.",
      link: `https://app.test/dashboard/inbox?chat=${CONVERSATION}`,
    });
  });

  it("tells staff a customer opted out, so they call instead of messaging", async () => {
    const outcome = await staffAlertContent(TENANT, { kind: "opted_out", conversationId: CONVERSATION }, deps());
    expect(outcome.headline).toBe("Asha Raman sent STOP, so the assistant won't message them again. Call them if you need to.");
  });

  it("asks staff how a visit went, and tells the owner about a low rating", async () => {
    const outcome = await staffAlertContent(TENANT, { kind: "visit_outcome", conversationId: CONVERSATION, what: "site visit" }, deps());
    expect(outcome.headline).toBe("How did the site visit with Asha Raman go? Update the lead so follow-ups stay right.");
    const low = await staffAlertContent(TENANT, { kind: "low_rating", conversationId: CONVERSATION, what: "site visit", rating: 2 }, deps());
    expect(low.headline).toBe("Asha Raman rated their site visit 2 out of 5.");
    expect(low.link).toBe(`https://app.test/dashboard/inbox?chat=${CONVERSATION}`);
  });

  it("tells the owner the business is out of credits, with the billing link", async () => {
    await expect(staffAlertContent(TENANT, { kind: "credits_exhausted" }, deps())).resolves.toEqual({
      headline: "Skyline Homes is out of credits, so the assistant has stopped replying.",
      link: "https://app.test/dashboard/billing",
    });
  });

  it("tells the owner how many credits are left when they run low, with the billing link", async () => {
    await expect(staffAlertContent(TENANT, { kind: "credits_low", credits: { left: 280, monthly: 1500 } }, deps())).resolves.toEqual({
      headline: "Skyline Homes has 280 credits left of its 1500 a month. Top up so the assistant keeps replying.",
      link: "https://app.test/dashboard/billing",
    });
    await expect(staffAlertContent(TENANT, { kind: "credits_low", credits: { left: 1, monthly: 300 } }, deps())).resolves.toMatchObject({
      headline: "Skyline Homes has 1 credit left of its 300 a month. Top up so the assistant keeps replying.",
    });
  });
});

describe("sendStaffAlert", () => {
  it("sends the line and the link as free text, and both as the template's variables", async () => {
    await sendStaffAlert(TENANT, OWNER, { kind: "handoff_opened", conversationId: CONVERSATION }, deps());
    const link = `https://app.test/dashboard/inbox?chat=${CONVERSATION}`;
    expect(sendMock).toHaveBeenCalledWith(TENANT, "staff_alert", {
      staffUserId: OWNER,
      text: `Asha Raman is waiting for a person on WhatsApp.\n${link}`,
      templateParams: ["Asha Raman is waiting for a person on WhatsApp.", link],
    });
  });

  it("passes an idempotency key through, so a repeat run never sends the alert twice", async () => {
    await sendStaffAlert(TENANT, OWNER, { kind: "credits_exhausted" }, deps(), { idempotencyKey: `credit_alert:used_up:7:${OWNER}` });
    expect(sendMock).toHaveBeenLastCalledWith(TENANT, "staff_alert", expect.objectContaining({ idempotencyKey: `credit_alert:used_up:7:${OWNER}` }));
  });
});

describe("staffAlertMessage: the lead card and the take-over links", () => {
  const HANDOFF = "5d6e7f80-91a2-43b4-85c6-d7e8f9a0b1c2";
  const card: LeadCard = {
    contact: { name: "Asha Raman", phone: "+919840012345", phoneMasked: "+9198xxxxxx45", language: "en" },
    need: "Looking at: Velachery, 2BHK, budget 60L",
    languageNote: "Writes in English",
    source: "WhatsApp",
    answers: ["Area: Velachery", "Budget: 60L"],
    score: 82,
    temperature: "hot",
    isHot: true,
    booking: null,
    trigger: "Asked for a discount",
    priority: "high",
    sentiment: "neutral",
    summary: "Looking at: Velachery, 2BHK, budget 60L\nLiked Skyline Towers.\nAsked for a better price.",
    nextStep: "Decide whether any discount is possible, then reply with a clear answer.",
    suggestedReply: null,
    discount: "Asked for ₹56 lakh instead of ₹60 lakh",
    owner: null,
    aiWritten: true,
  };
  const withCard = (over: Partial<StaffAlertDeps> = {}): StaffAlertDeps => ({
    ...deps(),
    card: vi.fn(async () => card),
    links: vi.fn((claims: HandoffLinkClaims, ownNumber: boolean) => ({
      inbox: `https://api.test/h/token-${claims.userId}?mode=inbox`,
      own: ownNumber ? `https://api.test/h/token-${claims.userId}?mode=own` : null,
    })),
    ownNumber: vi.fn(async () => true),
    ...over,
  });

  it("gives a handoff the card and this member's two take-over links; the template carries the inbox link", async () => {
    const d = withCard();
    const message = await staffAlertMessage(TENANT, OWNER, { kind: "handoff_opened", conversationId: CONVERSATION, handoffId: HANDOFF, priority: "high" }, d);
    expect(message.text.split("\n")).toEqual([
      "Priority: Asha Raman is waiting for a person on WhatsApp.",
      "Asked for a discount",
      "Looking at: Velachery, 2BHK, budget 60L",
      "Liked Skyline Towers.",
      "Asked for a better price.",
      "Asked for ₹56 lakh instead of ₹60 lakh",
      "Next: Decide whether any discount is possible, then reply with a clear answer.",
      `Take over in the inbox: https://api.test/h/token-${OWNER}?mode=inbox`,
      `Reply from your own WhatsApp: https://api.test/h/token-${OWNER}?mode=own`,
    ]);
    expect(message.templateParams).toEqual(["Priority: Asha Raman is waiting for a person on WhatsApp.", `https://api.test/h/token-${OWNER}?mode=inbox`]);
    expect(d.links).toHaveBeenCalledWith({ tenantId: TENANT, handoffId: HANDOFF, userId: OWNER }, true);
    expect(d.ownNumber).toHaveBeenCalledWith(TENANT);
  });

  it("shows only the inbox link on a plan without own-number takeover, and no prefix for a normal handoff", async () => {
    const message = await staffAlertMessage(TENANT, OWNER, { kind: "handoff_opened", conversationId: CONVERSATION, handoffId: HANDOFF, priority: "normal" }, withCard({ ownNumber: async () => false }));
    expect(message.text.startsWith("Asha Raman is waiting for a person on WhatsApp.\n")).toBe(true);
    expect(message.text).toContain("Take over in the inbox:");
    expect(message.text).not.toContain("own WhatsApp");
  });

  it("falls back to the dashboard link when take-over links aren't switched on, and to no card when it can't be built", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = await staffAlertMessage(
      TENANT,
      OWNER,
      { kind: "handoff_opened", conversationId: CONVERSATION, handoffId: HANDOFF },
      withCard({
        card: async () => {
          throw new Error("model down");
        },
        links: () => {
          throw new AppError("not_available", "Links to take over a chat aren't switched on yet.");
        },
      }),
    );
    expect(message.text).toBe(`Asha Raman is waiting for a person on WhatsApp.\nhttps://app.test/dashboard/inbox?chat=${CONVERSATION}`);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\[staff-alerts\] the lead card could not be added/));
    errors.mockRestore();
  });

  it("gives a hot lead the card without take-over links (it is not a handoff)", async () => {
    const message = await staffAlertMessage(TENANT, OWNER, { kind: "hot_lead", conversationId: CONVERSATION }, withCard());
    const lines = message.text.split("\n");
    expect(lines[0]).toBe("Hot lead: Asha Raman is ready to move.");
    expect(lines).not.toContain("Asked for a discount");
    expect(lines.at(-1)).toBe(`https://app.test/dashboard/inbox?chat=${CONVERSATION}`);
    expect(message.templateParams).toEqual(["Hot lead: Asha Raman is ready to move.", `https://app.test/dashboard/inbox?chat=${CONVERSATION}`]);
  });

  it("says a voice note is waiting, and that a customer wrote again during an own-number chat", async () => {
    await expect(staffAlertContent(TENANT, { kind: "voice_note", conversationId: CONVERSATION }, deps())).resolves.toMatchObject({
      headline: "Asha Raman sent a voice note. The assistant asked them to type; you can listen to it in the inbox.",
    });
    await expect(staffAlertContent(TENANT, { kind: "external_waiting", conversationId: CONVERSATION }, deps())).resolves.toMatchObject({
      headline: "Asha Raman wrote again while you have the chat on your own WhatsApp. Reply to them from your number.",
    });
  });

  it("leaves other alerts as they were: the headline and the link", async () => {
    const message = await staffAlertMessage(TENANT, OWNER, { kind: "opted_out", conversationId: CONVERSATION }, withCard());
    expect(message.text.split("\n")).toHaveLength(2);
  });
});

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { send } from "./send";
import { sendStaffAlert, staffAlertContent, staffAlertRecipients, type StaffAlertDeps } from "./staff-alerts";

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
      link: `https://app.test/dashboard/inbox?conversation=${CONVERSATION}`,
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

  it("says how long the customer has waited when no one picked the chat up", async () => {
    await expect(staffAlertContent(TENANT, { kind: "handoff_waiting", conversationId: CONVERSATION, waitedMinutes: 15 }, deps())).resolves.toEqual({
      headline: "Asha Raman has waited 15 minutes and no one has picked up the chat yet.",
      link: `https://app.test/dashboard/inbox?conversation=${CONVERSATION}`,
    });
    const one = await staffAlertContent(TENANT, { kind: "handoff_waiting", conversationId: CONVERSATION, waitedMinutes: 1 }, deps());
    expect(one.headline).toContain("waited 1 minute and");
  });

  it("asks the staff member how their own-number chat went", async () => {
    const outcome = await staffAlertContent(TENANT, { kind: "own_number_outcome", conversationId: CONVERSATION }, deps());
    expect(outcome).toEqual({
      headline: "How did your WhatsApp chat with Asha Raman go? Update the lead.",
      link: `https://app.test/dashboard/inbox?conversation=${CONVERSATION}`,
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
    expect(low.link).toBe(`https://app.test/dashboard/inbox?conversation=${CONVERSATION}`);
  });

  it("tells the owner the business is out of credits, with the billing link", async () => {
    await expect(staffAlertContent(TENANT, { kind: "credits_exhausted" }, deps())).resolves.toEqual({
      headline: "Skyline Homes is out of credits, so the assistant has stopped replying.",
      link: "https://app.test/dashboard/billing",
    });
  });
});

describe("sendStaffAlert", () => {
  it("sends the line and the link as free text, and both as the template's variables", async () => {
    await sendStaffAlert(TENANT, OWNER, { kind: "handoff_opened", conversationId: CONVERSATION }, deps());
    const link = `https://app.test/dashboard/inbox?conversation=${CONVERSATION}`;
    expect(sendMock).toHaveBeenCalledWith(TENANT, "staff_alert", {
      staffUserId: OWNER,
      text: `Asha Raman is waiting for a person on WhatsApp.\n${link}`,
      templateParams: ["Asha Raman is waiting for a person on WhatsApp.", link],
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { NotifyPayload, SendOutcome } from "../../notify/send";
import { areaReminderKey, areaReminderMessage, sendAreaReminder, type AreaReminderDeps } from "./area-reminder";

// A customer keeps asking for an area the business has no sites in (Raja, 14 Oct): the owners and admins are reminded, once, to record it in
// their CRM. One staff_alert through notify.send with our own text (free, behind the staff_alerts switch), like the connection alerts.

const T = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const APP = "https://app.example.test";

describe("the reminder's words", () => {
  it("name the customer and the area, say what to do, and link to the chat", () => {
    const message = areaReminderMessage({ label: "Priya", area: "Adyar" }, CONV, APP);
    expect(message.text).toContain("Priya");
    expect(message.text).toContain("Adyar");
    expect(message.text).toMatch(/CRM/);
    expect(message.text.endsWith(`${APP}/dashboard/inbox?chat=${CONV}`)).toBe(true);
  });

  it("are two template variables on one line each: the headline and the link", () => {
    const message = areaReminderMessage({ label: "Priya\nK", area: "Ad\tyar   Nagar" }, CONV, `${APP}/`);
    expect(message.templateParams).toHaveLength(2);
    expect(message.templateParams[0]).not.toMatch(/[\n\t]|\s{2,}/);
    expect(message.templateParams[1]).toBe(`${APP}/dashboard/inbox?chat=${CONV}`);
    expect(message.text.startsWith(message.templateParams[0])).toBe(true);
  });

  it("keep a long name or area short", () => {
    const message = areaReminderMessage({ label: "N".repeat(300), area: "A".repeat(300) }, CONV, APP);
    expect(message.templateParams[0].length).toBeLessThanOrEqual(200);
  });
});

describe("the key", () => {
  it("is the same for the same lead and place, however it is typed after normalising, and differs for another lead or another place", () => {
    expect(areaReminderKey(LEAD, "adyar")).toBe(areaReminderKey(LEAD, "adyar"));
    expect(areaReminderKey(LEAD, "adyar")).not.toBe(areaReminderKey(LEAD, "mylapore"));
    expect(areaReminderKey(LEAD, "adyar")).not.toBe(areaReminderKey("10000000-0000-0000-0000-0000000000f2", "adyar"));
  });

  it("leaves room for the member's id under notify.send's 200 characters, whatever the place is", () => {
    const key = areaReminderKey(LEAD, "வேளச்சேரி ".repeat(100));
    expect(`${key}:8f0e0000-0000-4000-8000-000000000001`.length).toBeLessThanOrEqual(200);
    expect(key).toMatch(/^[A-Za-z0-9:_-]+$/);
  });
});

function world(over: Partial<AreaReminderDeps> = {}) {
  const sent: { tenantId: string; payload: NotifyPayload }[] = [];
  const send = vi.fn(async (tenantId: string, _kind: "staff_alert", payload: NotifyPayload): Promise<SendOutcome> => {
    sent.push({ tenantId, payload });
    return { status: "sent", messageId: "m", providerMsgId: "w", creditsCharged: 0, usedTemplate: false };
  });
  const deps: AreaReminderDeps = {
    label: async () => "Priya",
    appUrl: APP,
    alert: { recipients: async () => ["u2", "u1"], send },
    ...over,
  };
  return { deps, sent, send };
}
const input = { tenantId: T, conversationId: CONV, leadId: LEAD, area: "Adyar", areaKey: "adyar" };

describe("sendAreaReminder", () => {
  it("sends one staff alert to each owner and admin, for this business, under a key that names the lead, the place and the person", async () => {
    const { deps, sent } = world();
    expect(await sendAreaReminder(input, deps)).toEqual({ recipients: 2, sent: 2, skipped: 0, failed: 0 });
    expect(sent.map((s) => s.tenantId)).toEqual([T, T]);
    expect(sent.map((s) => s.payload.staffUserId)).toEqual(["u2", "u1"]);
    expect(sent.map((s) => s.payload.idempotencyKey)).toEqual([`${areaReminderKey(LEAD, "adyar")}:u2`, `${areaReminderKey(LEAD, "adyar")}:u1`]);
    expect(sent[0].payload.text).toContain("Adyar");
    expect(sent[0].payload.text).toContain("Priya");
  });

  it("is the same key on a repeat, so notify.send answers with the first send and nothing goes twice", async () => {
    const { deps, sent } = world();
    await sendAreaReminder(input, deps);
    await sendAreaReminder(input, deps);
    expect(new Set(sent.map((s) => s.payload.idempotencyKey)).size).toBe(2);
  });

  it("never throws: a name that cannot be read becomes 'A customer', a member who cannot be reached is counted, a failed send is counted", async () => {
    const readFails = world({ label: async () => { throw new Error("db down"); } });
    expect(await sendAreaReminder(input, readFails.deps)).toMatchObject({ sent: 2 });
    expect(readFails.sent[0].payload.text).toContain("A customer");

    const noRecipients = world({ alert: { recipients: async () => { throw new Error("db down"); }, send: vi.fn() } });
    expect(await sendAreaReminder(input, noRecipients.deps)).toEqual({ recipients: 0, sent: 0, skipped: 0, failed: 1 });

    const mixed = world();
    mixed.send.mockResolvedValueOnce({ status: "skipped", reason: "feature_off" } as SendOutcome).mockRejectedValueOnce(new Error("boom"));
    expect(await sendAreaReminder(input, mixed.deps)).toEqual({ recipients: 2, sent: 0, skipped: 1, failed: 1 });
  });

  it("puts only what it is given in the text: the label it gets is already masked, and no token or full number is read here", async () => {
    const { deps, sent } = world({ label: async () => "+9198xxxxxx21" });
    await sendAreaReminder(input, deps);
    expect(sent[0].payload.text).toContain("+9198xxxxxx21");
    expect(sent[0].payload.templateParams?.[0]).not.toMatch(/\d{10}/); // (the link carries the chat's id, which has long runs of digits)
  });
});

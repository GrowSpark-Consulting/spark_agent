import { describe, expect, it, vi } from "vitest";
import type { NotifyPayload, SendOutcome } from "../../notify/send";
import { bookingChangeKey, bookingChangeReminderMessage, sendBookingChangeReminder, type BookingChangeReminderDeps } from "./booking-change-reminder";

// Finding 3: a customer with no booking on record asks to cancel or move one. The owners and admins are told, once per lead, with our own text (a staff_alert through
// notify.send, free, behind the staff_alerts switch), and nothing else changes: no handover, no mode change. The text holds the customer's cleaned name and the kind of
// change, never a word the customer typed.

const T = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const APP = "https://app.example.test";
const OUR_LINK = `${APP}/dashboard/inbox?chat=${CONV}`;
const digitsOf = (text: string) => text.replace(CONV, "").replace(/[ -]/g, "");

describe("the staff message", () => {
  it("says who, what kind of change, that there is no booking on record, what to do, and links to the chat", () => {
    const cancel = bookingChangeReminderMessage({ label: "Priya", kind: "cancel" }, CONV, APP);
    expect(cancel.text).toContain("Priya asked to cancel a booking, but none is on record for them in this chat.");
    expect(cancel.text).toMatch(/phone or by your team/);
    expect(cancel.text).toMatch(/Please check/);
    expect(cancel.text.split("\n").pop()).toBe(OUR_LINK);
    const move = bookingChangeReminderMessage({ label: "Priya", kind: "reschedule" }, CONV, `${APP}/`);
    expect(move.text).toContain("Priya asked to move a booking");
    expect(move.templateParams[1]).toBe(OUR_LINK);
  });

  it("is two template variables, each on one line", () => {
    const message = bookingChangeReminderMessage({ label: "Priya\nK", kind: "cancel" }, CONV, APP);
    expect(message.templateParams).toHaveLength(2);
    expect(message.templateParams[0]).not.toMatch(/[\n\t]|\s{2,}/);
    expect(message.text.startsWith(message.templateParams[0])).toBe(true);
  });

  it("the name passes the strict cleaner: a name with a link, a phone number or an @ is shown as 'A customer'", () => {
    for (const label of ["Priya 9876543210", "Priya http://evil.example", "priya@evil.example", "Priya <b>x</b>", "{area}", "", "   "]) {
      const message = bookingChangeReminderMessage({ label, kind: "cancel" }, CONV, APP);
      expect(message.text.startsWith("A customer asked to cancel a booking")).toBe(true);
      expect(message.text.replace(OUR_LINK, "")).not.toMatch(/https?:|@|evil/i);
      expect(digitsOf(message.text)).not.toMatch(/\d{7,}/);
    }
  });

  it("a masked number as the label (what the pipeline falls back to) is kept", () => {
    expect(bookingChangeReminderMessage({ label: "+9198xxxxxx21", kind: "cancel" }, CONV, APP).text).toContain("+9198xxxxxx21 asked to cancel");
  });

  it("a long name is cut", () => {
    const message = bookingChangeReminderMessage({ label: "N".repeat(300), kind: "cancel" }, CONV, APP);
    expect(message.templateParams[0].length).toBeLessThanOrEqual(200);
  });

  it("carries no customer words at all: only the name and the kind go in (there is no place to put a message, an area or a time)", () => {
    const input = { label: "Priya", kind: "cancel" as const, text: "cancel Priya Sharma's visit at 5 pm, call 9876543210", area: "Adyar" };
    const message = bookingChangeReminderMessage(input, CONV, APP);
    expect(message.text).not.toMatch(/Sharma|5 pm|9876543210|Adyar/);
  });
});

describe("the key", () => {
  it("is one per lead, whatever the kind of change", () => {
    expect(bookingChangeKey(LEAD)).toBe(`no_booking_change:${LEAD}`);
    expect(bookingChangeKey(LEAD)).not.toBe(bookingChangeKey("10000000-0000-0000-0000-0000000000f2"));
  });

  it("leaves room for the member's id under notify.send's 200 characters", () => {
    expect(`${bookingChangeKey(LEAD)}:8f0e0000-0000-4000-8000-000000000001`.length).toBeLessThanOrEqual(200);
  });
});

function world(over: Partial<BookingChangeReminderDeps> = {}) {
  const sent: { tenantId: string; kind: string; payload: NotifyPayload }[] = [];
  const send = vi.fn(async (tenantId: string, kind: "staff_alert", payload: NotifyPayload): Promise<SendOutcome> => {
    sent.push({ tenantId, kind, payload });
    return { status: "sent", messageId: "m", providerMsgId: "w", creditsCharged: 0, usedTemplate: false };
  });
  const deps: BookingChangeReminderDeps = { label: async () => "Priya", appUrl: APP, alert: { recipients: async () => ["u2", "u1"], send }, ...over };
  return { deps, send, sent };
}
const input = { tenantId: T, conversationId: CONV, leadId: LEAD, kind: "cancel" as const };

describe("sending", () => {
  it("is one staff_alert to each owner and admin, free, under a key of the lead and the member, with the message and its template variables", async () => {
    const { deps, sent } = world();
    const counts = await sendBookingChangeReminder(input, deps);
    expect(counts).toEqual({ recipients: 2, sent: 2, skipped: 0, failed: 0 });
    expect(sent.map((s) => s.kind)).toEqual(["staff_alert", "staff_alert"]);
    expect(sent.map((s) => s.payload.idempotencyKey)).toEqual([`${bookingChangeKey(LEAD)}:u2`, `${bookingChangeKey(LEAD)}:u1`]);
    expect(sent[0].payload.text ?? "").toContain("Priya asked to cancel a booking");
    expect(sent[0].payload.templateParams).toHaveLength(2);
    expect(sent[0].payload.conversationId).toBeUndefined();
  });

  it("names the kind of change", async () => {
    const { deps, sent } = world();
    await sendBookingChangeReminder({ ...input, kind: "reschedule" }, deps);
    expect(sent[0].payload.text ?? "").toContain("asked to move a booking");
  });

  it("a name that cannot be read does not lose the reminder: it says 'A customer'", async () => {
    const { deps, sent } = world({ label: async () => { throw new Error("db down"); } });
    await sendBookingChangeReminder(input, deps);
    expect(sent[0].payload.text?.startsWith("A customer asked to cancel")).toBe(true);
  });

  it("nobody to tell, a switch that is off and a send that breaks are counted, and never thrown", async () => {
    expect(await sendBookingChangeReminder(input, world({ alert: { recipients: async () => [], send: vi.fn() } }).deps)).toMatchObject({ recipients: 0, sent: 0 });
    expect(await sendBookingChangeReminder(input, world({ alert: { recipients: async () => { throw new Error("down"); }, send: vi.fn() } }).deps)).toMatchObject({ sent: 0, failed: 1 });
    const off = vi.fn(async (): Promise<SendOutcome> => ({ status: "skipped", reason: "feature_off" }));
    expect(await sendBookingChangeReminder(input, world({ alert: { recipients: async () => ["u1"], send: off } }).deps)).toMatchObject({ sent: 0, skipped: 1 });
    const broken = vi.fn(async (): Promise<SendOutcome> => { throw new Error("boom"); });
    expect(await sendBookingChangeReminder(input, world({ alert: { recipients: async () => ["u1"], send: broken } }).deps)).toMatchObject({ sent: 0, failed: 1 });
    const refused = vi.fn(async (): Promise<SendOutcome> => ({ status: "failed", error: { code: "not_available", message: "x", retryable: false, outcomeUnknown: false } }));
    expect(await sendBookingChangeReminder(input, world({ alert: { recipients: async () => ["u1"], send: refused } }).deps)).toMatchObject({ sent: 0, failed: 1 });
  });
});

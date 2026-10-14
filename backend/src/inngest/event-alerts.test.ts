import { describe, expect, it, vi } from "vitest";
import type { SendOutcome } from "../notify/send";
import type { StaffAlert } from "../notify/staff-alerts";
import { handleStaffEvent, type EventAlertDeps } from "./event-alerts";

const TENANT = "8e7d6c5b-4a39-4281-9f0e-1d2c3b4a5968";
const CONVERSATION = "2b3c4d5e-6f70-4812-93a4-b5c6d7e8f901";
const STAFF = "0f1e2d3c-4b5a-4697-8877-665544332211";

const step = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };
const sent: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "w", creditsCharged: 0, usedTemplate: false };

function deps(assigned: string | null = null, outcome: SendOutcome = sent) {
  const alert = vi.fn<(tenantId: string, userId: string, alert: StaffAlert, key: string) => Promise<SendOutcome>>(async () => outcome);
  const recipients = vi.fn(async () => ["owner-1", "admin-2"]);
  const assignedTo = vi.fn(async () => assigned);
  const d: EventAlertDeps = { recipients, assignedTo, alert };
  return { d, alert, recipients, assignedTo };
}

describe("event-alerts", () => {
  it("tells owners and admins about a hot lead, once per lead (keyed by Dev 1's event id)", async () => {
    const { d, alert } = deps();
    const result = await handleStaffEvent({ event: { name: "lead.hot", id: "lead_hot:lead-9", data: { tenantId: TENANT, leadId: "lead-9", conversationId: CONVERSATION } }, step }, d);
    expect(result).toEqual({ kind: "hot_lead", results: [{ userId: "owner-1", status: "sent" }, { userId: "admin-2", status: "sent" }] });
    expect(alert).toHaveBeenCalledWith(TENANT, "owner-1", { kind: "hot_lead", conversationId: CONVERSATION }, "lead_hot:lead-9:owner-1");
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts): notify.send keeps one message per key (notify/send.test.ts).
  it("replay: the same event twice alerts under the same keys (the event's id and the member), so each hears once", async () => {
    const { d, alert } = deps();
    const hot = { event: { name: "lead.hot", id: "lead_hot:lead-9", data: { tenantId: TENANT, leadId: "lead-9", conversationId: CONVERSATION } }, step };
    await handleStaffEvent(hot, d);
    await handleStaffEvent(hot, d);
    expect(alert.mock.calls.map((x) => x[3])).toEqual(["lead_hot:lead-9:owner-1", "lead_hot:lead-9:admin-2", "lead_hot:lead-9:owner-1", "lead_hot:lead-9:admin-2"]);
  });

  it("tells owners and admins a voice note is waiting", async () => {
    const { d, alert } = deps();
    await handleStaffEvent({ event: { name: "voice_note.received", id: "voice_note:m-3", data: { tenantId: TENANT, conversationId: CONVERSATION, leadId: "l" } }, step }, d);
    expect(alert).toHaveBeenCalledWith(TENANT, "admin-2", { kind: "voice_note", conversationId: CONVERSATION }, "voice_note:m-3:admin-2");
  });

  it("pings the staff member who has the chat on their own WhatsApp, and owners and admins when nobody has it", async () => {
    const mine = deps(STAFF);
    const event = { name: "chat.external_waiting", id: "external_waiting:m-5", data: { tenantId: TENANT, conversationId: CONVERSATION, messageId: "m-5" } };
    await expect(handleStaffEvent({ event, step }, mine.d)).resolves.toMatchObject({ kind: "external_waiting", results: [{ userId: STAFF }] });
    expect(mine.assignedTo).toHaveBeenCalledWith(TENANT, CONVERSATION);
    expect(mine.recipients).not.toHaveBeenCalled();
    expect(mine.alert).toHaveBeenCalledWith(TENANT, STAFF, { kind: "external_waiting", conversationId: CONVERSATION }, `external_waiting:m-5:${STAFF}`);

    const nobody = deps(null);
    await expect(handleStaffEvent({ event, step }, nobody.d)).resolves.toMatchObject({ results: [{ userId: "owner-1" }, { userId: "admin-2" }] });
  });

  it("ignores an event it does not know, and refuses data without ids", async () => {
    const { d, alert } = deps();
    await expect(handleStaffEvent({ event: { name: "chat.phone_reply", data: { tenantId: TENANT, conversationId: CONVERSATION } }, step }, d)).resolves.toEqual({ skipped: "unknown_event" });
    await expect(handleStaffEvent({ event: { name: "lead.hot", data: { tenantId: "nope" } }, step }, d)).rejects.toThrow();
    expect(alert).not.toHaveBeenCalled();
  });

  it("retries a send that may work later, never one WhatsApp may have delivered", async () => {
    const event = { name: "lead.hot", id: "lead_hot:l", data: { tenantId: TENANT, conversationId: CONVERSATION } };
    const later = deps(null, { status: "failed", error: { code: "rate_limited", message: "", retryable: true, outcomeUnknown: false } });
    await expect(handleStaffEvent({ event, step }, later.d)).rejects.toThrow("will retry");
    const maybe = deps(null, { status: "failed", error: { code: "upstream_failed", message: "", retryable: true, outcomeUnknown: true } });
    await expect(handleStaffEvent({ event, step }, maybe.d)).resolves.toMatchObject({ results: [{ status: "failed", code: "upstream_failed" }, { status: "failed" }] });
  });
});

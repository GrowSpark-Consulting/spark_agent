import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Finding 3: "one reminder per lead" must not block a retry after a FAILED send, and must never send twice after a SUCCESS. This runs the REAL notify.send (Dev 2's, read only:
// its keyed claim of migration 0045) through our reminder, with an in-memory stand-in for the database's three functions and the messages table, written from
// supabase/migrations/0045_notify_attempts.sql:
//   claim_notify_attempt: 'sent' when the message is recorded, 'claimed' for a new or released claim, 'in_doubt' for a claim still 'sending';
//   release_notify_attempt: 'sending' -> 'released'.  notify_record: the message row.
// What is proved is how OUR key behaves under notify.send's rules; the SQL itself is Dev 2's and has its own tests (supabase/tests).

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };
const attempts = new Map<string, "sending" | "released">();
const messages = new Map<string, Record<string, unknown>>();
const rpcCalls: string[] = [];
const ok = (data: unknown): RpcResult => ({ data, error: null });

const rpc = vi.fn(async (fn: string, args: Record<string, unknown>): Promise<RpcResult> => {
  rpcCalls.push(fn);
  const id = args.p_message_id as string;
  switch (fn) {
    case "notify_staff_target":
      return ok([{ connection_id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", conversation_id: "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601", contact_id: "6fa459ea-ee8a-4ca4-894e-db77e160355e", to_phone: "+919800011111", opted_out: false, last_customer_msg_at: new Date(Date.now() - 3_600_000).toISOString(), language: "en", recent_test_messages: 0 }]);
    case "claim_notify_attempt": {
      if (messages.has(id)) return ok("sent");
      const state = attempts.get(id);
      if (state === undefined || state === "released") {
        attempts.set(id, "sending");
        return ok("claimed");
      }
      return ok("in_doubt");
    }
    case "release_notify_attempt":
      if (attempts.get(id) === "sending") attempts.set(id, "released");
      return ok(null);
    case "notify_record":
      messages.set(id, { id, provider_msg_id: args.p_provider_msg_id, credits_charged: args.p_credits, template_name: args.p_template_name });
      return ok(null);
    default:
      return ok(null);
  }
});

// A query builder for the one table notify.send reads: messages, by id.
const from = (table: string) => {
  let ids: string[] = [];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    limit: () => builder,
    in: (_column: string, values: string[]) => ((ids = values), builder),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: table === "messages" ? ids.filter((id) => messages.has(id)).map((id) => messages.get(id)) : [], error: null }),
  };
  return builder;
};
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: () => ({ rpc, from }) as unknown as SupabaseClient }));
vi.mock("../../features/is-enabled", () => ({ isEnabled: vi.fn(async () => true), isSwitchedOn: vi.fn(async () => true) }));
vi.mock("../../inngest/client", () => ({ inngest: { send: vi.fn(async () => ({ ids: [] })) } }));

const { send } = await import("../../notify/send");
const { registerSender, SendError } = await import("../../notify/sender");
const { bookingChangeKey, sendBookingChangeReminder } = await import("./booking-change-reminder");

const T = "e0000000-0000-4000-8000-00000000000a";
const CONV = "c0000000-0000-4000-8000-00000000000c";
const LEAD = "10000000-0000-4000-8000-0000000000f1";
const OTHER_LEAD = "10000000-0000-4000-8000-0000000000f2";
const sender = { sendText: vi.fn(), sendTemplate: vi.fn(), sendInteractive: vi.fn() };

const deps = (recipients: string[] = ["11111111-1111-4111-8111-111111111111"]) => ({
  label: async () => "Priya",
  appUrl: "https://app.example.test",
  alert: { recipients: async () => recipients, send: (tenantId: string, kind: "staff_alert", payload: Parameters<typeof send>[2]) => send(tenantId, kind, payload) },
});
const remind = (leadId = LEAD, recipients?: string[]) => sendBookingChangeReminder({ tenantId: T, conversationId: CONV, leadId, kind: "cancel" }, deps(recipients));

beforeEach(() => {
  attempts.clear();
  messages.clear();
  rpcCalls.length = 0;
  rpc.mockClear();
  sender.sendText.mockReset().mockResolvedValue({ providerMsgId: "wamid.ok" });
  sender.sendTemplate.mockReset().mockResolvedValue({ providerMsgId: "wamid.tpl" });
  sender.sendInteractive.mockReset();
  registerSender(async () => sender);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a failed send can be tried again by a later message of the same lead", () => {
  it("WhatsApp refuses it for certain: the claim is released, so the next message's attempt sends, and the one after that sends nothing", async () => {
    sender.sendText.mockRejectedValueOnce(new SendError("upstream_failed", "WhatsApp refused it", { retryable: true }));
    expect(await remind()).toMatchObject({ sent: 0, failed: 1 });
    expect(rpcCalls).toContain("release_notify_attempt");
    expect(messages.size).toBe(0);

    expect(await remind()).toMatchObject({ sent: 1, failed: 0 });
    expect(sender.sendText).toHaveBeenCalledTimes(2);
    expect(messages.size).toBe(1);

    // a later message: the earlier send is found, nothing goes out again, and it still counts as sent (the customer may be told the team knows)
    expect(await remind()).toMatchObject({ sent: 1, failed: 0 });
    expect(await remind()).toMatchObject({ sent: 1, failed: 0 });
    expect(sender.sendText).toHaveBeenCalledTimes(2);
    expect(messages.size).toBe(1);
  });

  it("several refusals in a row never block the next try", async () => {
    sender.sendText.mockRejectedValue(new SendError("not_available", "refused", { retryable: false }));
    for (let i = 0; i < 3; i++) expect(await remind()).toMatchObject({ sent: 0, failed: 1 });
    sender.sendText.mockResolvedValue({ providerMsgId: "wamid.ok" });
    expect(await remind()).toMatchObject({ sent: 1 });
    expect(sender.sendText).toHaveBeenCalledTimes(4);
  });

  it("a switch that is off, or nobody to tell, sends nothing and claims nothing: a later message can still try", async () => {
    const { isEnabled } = await import("../../features/is-enabled");
    vi.mocked(isEnabled).mockResolvedValueOnce(false);
    expect(await remind()).toMatchObject({ sent: 0, skipped: 1 });
    expect(attempts.size).toBe(0);
    expect(await remind(LEAD, [])).toMatchObject({ recipients: 0, sent: 0 });
    expect(await remind()).toMatchObject({ sent: 1 });
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });
});

describe("a send that went out is never sent twice", () => {
  it("after a success, any number of later messages send nothing (the recorded message is found)", async () => {
    expect(await remind()).toMatchObject({ sent: 1 });
    for (let i = 0; i < 5; i++) expect(await remind()).toMatchObject({ sent: 1, failed: 0 });
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });

  it("an unknown outcome (WhatsApp never answered) keeps its claim: nothing is ever resent, and it is counted as not sent so the customer is not told someone knows", async () => {
    sender.sendText.mockRejectedValueOnce(new SendError("upstream_failed", "timed out", { outcomeUnknown: true }));
    expect(await remind()).toMatchObject({ sent: 0, failed: 1 });
    expect(await remind()).toMatchObject({ sent: 0, failed: 1 });
    expect(await remind()).toMatchObject({ sent: 0, failed: 1 });
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });

  it("the record of a send was lost (notify_record failed): the claim stays, so a later message sends nothing (in doubt), never twice", async () => {
    const real = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (fn, args) => (fn === "notify_record" ? { data: null, error: { message: "db down" } } : real(fn, args)));
    expect(await remind()).toMatchObject({ sent: 1 });
    rpc.mockImplementation(real);
    expect(await remind()).toMatchObject({ sent: 0, failed: 1 });
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });

  it("two members get one each, and a retry for the member whose send was refused leaves the other alone", async () => {
    const [a, b] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    sender.sendText.mockResolvedValueOnce({ providerMsgId: "wamid.a" }).mockRejectedValueOnce(new SendError("upstream_failed", "refused", { retryable: true }));
    expect(await remind(LEAD, [a, b])).toMatchObject({ recipients: 2, sent: 1, failed: 1 });
    expect(await remind(LEAD, [a, b])).toMatchObject({ recipients: 2, sent: 2, failed: 0 });
    expect(sender.sendText).toHaveBeenCalledTimes(3);
  });
});

describe("the key is per lead", () => {
  it("another lead's reminder is its own, and does not see this one's", async () => {
    expect(await remind(LEAD)).toMatchObject({ sent: 1 });
    expect(await remind(OTHER_LEAD)).toMatchObject({ sent: 1 });
    expect(sender.sendText).toHaveBeenCalledTimes(2);
    expect(bookingChangeKey(LEAD)).not.toBe(bookingChangeKey(OTHER_LEAD));
  });
});

import { redactSecrets } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { CREDIT_COST } from "../billing/credit-costs";
import { refundCredits, spendCredits } from "../billing/credits";
import { isEnabled } from "../features/is-enabled";
import { supabaseAdmin } from "../lib/supabase-admin";
import { Interactive, interactiveSummary } from "./interactive";
import { KINDS, type MessageCreditReason, type NotificationKind } from "./kinds";
import { OutsideWindowError, SendError, senderFactory, type MessageSender } from "./sender";

// notify.send (docs/handover.md, module 5; docs/contracts.md, section 4): every outbound message goes
// through here. Order: feature toggle → recipient and connection → opt-out → test-message limit →
// 24-hour window (free text, or reply buttons / a list) or approved template → credits → send → record
// (messages + audit_logs).
// If the send fails after credits were spent, they are refunded. If WhatsApp says the window has
// closed (OutsideWindowError), the approved template is sent instead. Any other refusal keeps the
// sender's code (rate_limited, whatsapp_not_connected…). When the outcome is unknown (a timeout), the
// credits are refunded too and the failure says outcomeUnknown, so nobody resends it; holding them
// instead waits for Raja (docs/contracts.md, decision 16).

export type NotifyPayload = {
  /** Customer messages: the conversation to reply in. */
  conversationId?: string;
  /** test_message only: the E.164 number staff typed. */
  to?: string;
  /** staff_alert only: the member whose alert number (memberships.whatsapp_phone) receives it. */
  staffUserId?: string;
  /** Free-text body, used inside the 24-hour window. */
  text?: string;
  /**
   * Reply buttons or a list (notify/interactive.ts), sent instead of `text` inside the 24-hour window. Outside it the
   * kind's approved template goes, as for text. Checked against Meta's limits before any credit is spent.
   */
  interactive?: Interactive;
  /** Template variables in {{1}}… order, used outside the window. */
  templateParams?: string[];
  /**
   * staff_reply only: an approved template a staff member chose (the inbox's template picker), by its exact versioned
   * name and language, with its body variables in {{1}}… order. Sent whatever the window; free, like any staff reply.
   */
  template?: { name: string; language: string; params: string[] };
  /** The staff user who sent it (staff_reply, test_message); recorded in audit_logs. */
  actorId?: string;
  /**
   * Names this exact message (for example `reminder_24h:<bookingId>:<start>`), so a job's retry never sends it twice:
   * the message id is derived from it, and once that message has gone out, a repeat returns the first send's outcome
   * without sending or charging again. Up to 200 characters.
   */
  idempotencyKey?: string;
};

export type SendOutcome =
  | { status: "sent"; messageId: string; providerMsgId: string; creditsCharged: number; usedTemplate: boolean }
  | {
      status: "skipped";
      reason: "feature_off" | "opted_out" | "insufficient_credits" | "outside_window";
    }
  | {
      status: "failed";
      /**
       * `retryable`: a later attempt may work. `outcomeUnknown`: WhatsApp may have delivered the message
       * anyway (no answer in time), so it must never be resent automatically.
       */
      error: { code: string; message: string; retryable: boolean; outcomeUnknown: boolean };
    };

export const TEST_MESSAGES_PER_HOUR = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;

const Target = z.object({
  connection_id: z.guid(),
  conversation_id: z.guid(),
  contact_id: z.guid(),
  to_phone: z.string(),
  opted_out: z.boolean(),
  last_customer_msg_at: z.string().nullable(),
  language: z.string().nullable(),
  recent_test_messages: z.number().int(),
});
const Template = z.object({ name: z.string(), language: z.string(), category: z.string() });

// A staff-chosen template: Meta's name and language formats; the adapter checks each variable's text.
const ChosenTemplate = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
  params: z.array(z.string()).max(20),
});
const ApprovedTemplate = Template.extend({ components: z.unknown() });

/**
 * How many {{n}} variables a template's body has, from `whatsapp_templates.components`: as submitted ({ body, … }) or
 * as Meta lists it ([{ type: "BODY", text }]). Null when the body can't be found, so the count is left to Meta.
 */
export function templateVariableCount(components: unknown): number | null {
  let body: unknown;
  if (Array.isArray(components)) {
    body = components.find((c) => typeof c === "object" && c !== null && String((c as { type?: unknown }).type).toUpperCase() === "BODY")?.text;
  } else if (typeof components === "object" && components !== null) {
    body = (components as { body?: unknown }).body;
  }
  if (typeof body !== "string") return null;
  return new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1])).size;
}

const failed = (
  code: string,
  message: string,
  { retryable = false, outcomeUnknown = false }: { retryable?: boolean; outcomeUnknown?: boolean } = {},
): SendOutcome => ({ status: "failed", error: { code, message, retryable, outcomeUnknown } });

/** The same message always gets the same id: a UUID (RFC 4122 version 5 layout) from the business, the kind and the key. */
export function keyedMessageId(tenantId: string, kind: NotificationKind, key: string): string {
  const hash = createHash("sha1").update(`pakka:notify:${tenantId}:${kind}:${key}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A message that fell back to the template (the window closed mid-send) went out under its own id.
const templateFallbackKey = (key: string) => `${key}#template`;

const SentRow = z.object({ id: z.guid(), provider_msg_id: z.string().nullable(), credits_charged: z.number().int(), template_name: z.string().nullable() });

/** The earlier send of this key, if it went out (notify_record wrote its row). */
async function earlierSend(db: SupabaseClient, tenantId: string, kind: NotificationKind, key: string): Promise<SendOutcome | null> {
  const ids = [keyedMessageId(tenantId, kind, key), keyedMessageId(tenantId, kind, templateFallbackKey(key))];
  const { data, error } = await db.from("messages").select("id, provider_msg_id, credits_charged, template_name").eq("tenant_id", tenantId).in("id", ids).limit(1);
  if (error) throw new Error(`notify.send: checking for an earlier send failed: ${error.message}`);
  const [row] = z.array(SentRow).parse(data ?? []);
  if (!row) return null;
  return { status: "sent", messageId: row.id, providerMsgId: row.provider_msg_id ?? "", creditsCharged: row.credits_charged, usedTemplate: row.template_name !== null };
}

/** A sender's SendError keeps its code and flags; anything else is unexpected, so it is logged and generic. */
function senderFailure(err: unknown, message: string): SendOutcome {
  if (err instanceof SendError) return failed(err.code, err.message, { retryable: err.retryable, outcomeUnknown: err.outcomeUnknown });
  console.error(`[notify] unexpected sender error: ${redactSecrets(err instanceof Error ? `${err.name}: ${err.message}` : String(err))}`);
  return failed("upstream_failed", message);
}

export async function send(tenantId: string, kind: NotificationKind, payload: NotifyPayload): Promise<SendOutcome> {
  const kindConfig = KINDS[kind];
  const missing = {
    number: !payload.to || !payload.text ? "to and text" : null,
    staff: !payload.staffUserId ? "staffUserId" : null,
    conversation: !payload.conversationId ? "conversationId" : null,
  }[kindConfig.audience];
  if (missing) throw new Error(`notify.send(${kind}): ${missing} required`);
  const key = payload.idempotencyKey;
  if (key !== undefined && (typeof key !== "string" || key.length === 0 || key.length > 200)) {
    throw new Error(`notify.send(${kind}): idempotencyKey must be 1 to 200 characters`);
  }
  if (payload.interactive !== undefined && !Interactive.safeParse(payload.interactive).success) {
    return failed("validation_failed", "The buttons or list don't fit WhatsApp's limits, so the message was not sent.");
  }
  const chosen = payload.template;
  if (chosen !== undefined) {
    if (!kindConfig.chosenTemplate) throw new Error(`notify.send(${kind}): only a staff reply can send a chosen template`);
    if (!ChosenTemplate.safeParse(chosen).success) return failed("validation_failed", "Choose an approved template and fill in its values.");
  }

  const db = supabaseAdmin();
  // Before anything else: a message that has already gone out is never sent again, whatever changed since.
  if (key !== undefined) {
    const earlier = await earlierSend(db, tenantId, kind, key);
    if (earlier) return earlier;
  }

  if (kindConfig.feature && !(await isEnabled(tenantId, kindConfig.feature))) {
    return { status: "skipped", reason: "feature_off" };
  }

  const factory = senderFactory();
  if (!factory) {
    return failed("not_available", "Sending WhatsApp messages isn't switched on yet, so the message was not sent.");
  }

  const targetResult =
    kindConfig.audience === "staff"
      ? await db.rpc("notify_staff_target", { p_tenant_id: tenantId, p_user_id: payload.staffUserId })
      : await db.rpc("notify_target", {
          p_tenant_id: tenantId,
          p_conversation_id: payload.conversationId ?? null,
          p_to: payload.to ?? null,
        });
  if (targetResult.error) {
    if (targetResult.error.code === "PA404") {
      return failed("not_found", kindConfig.audience === "staff" ? "That person has no WhatsApp number for alerts." : "That conversation was not found.");
    }
    if (targetResult.error.code === "PA409") {
      return failed("whatsapp_not_connected", "This business has no connected WhatsApp number, so the message was not sent.");
    }
    throw new Error(`notify_target failed: ${targetResult.error.message}`);
  }
  const [target] = z.array(Target).length(1).parse(targetResult.data);

  if (target.opted_out && !kindConfig.ignoresOptOut) return { status: "skipped", reason: "opted_out" };
  if (kind === "test_message" && target.recent_test_messages >= TEST_MESSAGES_PER_HOUR) {
    return failed("rate_limited", `Only ${TEST_MESSAGES_PER_HOUR} test messages an hour. Try again later.`, { retryable: true });
  }

  // Free-form (text, buttons, a list) only inside 24 hours of the customer's last message; otherwise an approved template.
  const lastCustomerMessage = target.last_customer_msg_at ? Date.parse(target.last_customer_msg_at) : null;
  const insideWindow = lastCustomerMessage !== null && Date.now() - lastCustomerMessage < WINDOW_MS;
  let template: z.infer<typeof Template> | undefined;
  if (chosen) {
    // Only an approved template of this business's connected number, with exactly the values its body asks for.
    const found = await db
      .from("whatsapp_templates")
      .select("name, language, category, components")
      .eq("tenant_id", tenantId)
      .eq("connection_id", target.connection_id)
      .eq("name", chosen.name)
      .eq("language", chosen.language)
      .eq("status", "approved")
      .limit(1);
    if (found.error) throw new Error(`notify.send: template read failed: ${found.error.message}`);
    const [approved] = z.array(ApprovedTemplate).max(1).parse(found.data ?? []);
    if (!approved) return failed("not_found", "That template isn't approved for this WhatsApp number.");
    const needed = templateVariableCount(approved.components);
    if (needed !== null && needed !== chosen.params.length) {
      return failed("validation_failed", `This template needs ${needed} value${needed === 1 ? "" : "s"}.`);
    }
    template = { name: approved.name, language: approved.language, category: approved.category };
  } else if (!(insideWindow && (payload.interactive ?? payload.text))) {
    if (!kindConfig.template) return { status: "skipped", reason: "outside_window" };
    const templateResult = await db.rpc("notify_template", {
      p_connection_id: target.connection_id,
      p_base_name: kindConfig.template,
      p_language: target.language ?? "en",
    });
    if (templateResult.error) throw new Error(`notify_template failed: ${templateResult.error.message}`);
    template = z.array(Template).max(1).parse(templateResult.data)[0];
    if (!template) return { status: "skipped", reason: "outside_window" };
  }

  const reason: MessageCreditReason | undefined = template
    ? template.category === "marketing" ? "template_marketing" : "template_utility"
    : kindConfig.freeTextReason;
  const cost = kindConfig.charged && reason ? CREDIT_COST[reason] : 0;

  let sender: MessageSender;
  try {
    sender = await factory({ tenantId, connectionId: target.connection_id });
  } catch (err) {
    return senderFailure(err, "The WhatsApp connection could not be used, so the message was not sent.");
  }

  const messageId = key !== undefined ? keyedMessageId(tenantId, kind, key) : randomUUID();
  if (cost > 0 && reason && !(await spendCredits(tenantId, cost, reason, messageId))) {
    return { status: "skipped", reason: "insufficient_credits" };
  }

  let providerMsgId: string;
  try {
    const sent = template
      ? await sender.sendTemplate(target.to_phone, template.name, template.language, chosen ? chosen.params : (payload.templateParams ?? []))
      : payload.interactive
        ? await sender.sendInteractive(target.to_phone, payload.interactive)
        : await sender.sendText(target.to_phone, payload.text as string);
    providerMsgId = sent.providerMsgId;
  } catch (err) {
    if (cost > 0) await refundCredits(tenantId, messageId);
    // The window closed between our check and WhatsApp's. Send again without the free-form message,
    // which picks the kind's approved template; a kind with no template is skipped.
    if (err instanceof OutsideWindowError && !template) {
      if (!kindConfig.template) return { status: "skipped", reason: "outside_window" };
      return send(tenantId, kind, {
        ...payload,
        text: undefined,
        interactive: undefined,
        idempotencyKey: key !== undefined ? templateFallbackKey(key) : undefined,
      });
    }
    return senderFailure(err, "WhatsApp did not accept the message, so it was not sent.");
  }

  const actor = payload.actorId ?? (kindConfig.sender === "ai" ? "ai" : "system");
  const recorded = await db.rpc("notify_record", {
    p_tenant_id: tenantId,
    p_message_id: messageId,
    p_conversation_id: target.conversation_id,
    p_sender: kindConfig.sender,
    p_body: template ? null : payload.interactive ? interactiveSummary(payload.interactive) : (payload.text ?? null),
    p_template_name: template?.name ?? null,
    p_provider_msg_id: providerMsgId,
    p_credits: cost,
    p_actor: actor,
    p_kind: kind,
  });
  // The message has gone out and is paid for; a retry would send it twice. Log and report it as sent.
  if (recorded.error) console.error(`notify_record failed for message ${messageId}: ${recorded.error.message}`);

  return { status: "sent", messageId, providerMsgId, creditsCharged: cost, usedTemplate: Boolean(template) };
}

import { z } from "zod";

// E.164 with a leading "+". Meta sends bare digits; the WhatsApp parser in backend normalises them
// before building an InboundMessage.
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
export const E164 = z.string().regex(E164_PATTERN, "must be E.164, e.g. +919812345621");

/** E164 as a person types it into a form: trimmed, with an error written for them. */
export const PhoneInput = z
  .string()
  .trim()
  .regex(E164_PATTERN, "Enter the number with country code, like +919840012345");

export const InboundMessageType = z.enum([
  "text",
  "interactive",
  "image",
  "audio",
  "location",
  "document",
]);

export const InboundMessage = z.object({
  tenantId: z.guid(),
  channelId: z.guid(),
  providerMsgId: z.string().min(1),
  from: E164,
  contactName: z.string().optional(),
  type: InboundMessageType,
  text: z.string().optional(),
  buttonId: z.string().optional(),
  media: z.object({ id: z.string().min(1), mime: z.string().min(1) }).optional(),
  timestamp: z.iso.datetime({ offset: true }),
  routeCode: z.string().optional(), // DEMO-/TRIAL- code on the shared number
});
export type InboundMessage = z.infer<typeof InboundMessage>;

export const DeliveryStatus = z.enum(["sent", "delivered", "read", "failed"]);

export const StatusUpdate = z.object({
  providerMsgId: z.string().min(1),
  status: DeliveryStatus,
  timestamp: z.iso.datetime({ offset: true }),
  recipient: E164.optional(),
  error: z.object({ code: z.number().int(), message: z.string() }).optional(),
});
export type StatusUpdate = z.infer<typeof StatusUpdate>;

export const SendResult = z.object({
  providerMsgId: z.string().min(1),
});
export type SendResult = z.infer<typeof SendResult>;

/** WhatsApp's limit for a text message body. */
export const WHATSAPP_TEXT_MAX = 4096;

export const SendTestMessageInput = z.object({
  to: PhoneInput,
  body: z
    .string()
    .trim()
    .min(1, "Write a message")
    .max(WHATSAPP_TEXT_MAX, `Keep it under ${WHATSAPP_TEXT_MAX} characters`),
});
export type SendTestMessageInput = z.infer<typeof SendTestMessageInput>;

/**
 * Result of POST /api/messages/test. "accepted" means Meta took the message; whether it was
 * delivered arrives later as a StatusUpdate through the webhook.
 */
export interface SendTestMessageResult extends SendResult {
  status: "accepted";
}

/**
 * Body of POST /api/conversations/:id/messages: a free-text reply from staff, inside the 24-hour window.
 * Strict on purpose: any other field is refused, not silently dropped. A template staff chose is the other body,
 * SendStaffTemplateInput.
 */
export const SendStaffReplyInput = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Write a message")
      .max(WHATSAPP_TEXT_MAX, `Keep it under ${WHATSAPP_TEXT_MAX} characters`),
  })
  .strict();
export type SendStaffReplyInput = z.infer<typeof SendStaffReplyInput>;

/**
 * The other body of POST /api/conversations/:id/messages: an approved template staff chose (the inbox's template
 * picker), by its exact versioned name and language, with its body variables in {{1}}… order. Sent whatever the 24-hour
 * window, free. Only a template approved for the business's connected number is used (not_found otherwise), and the
 * number of values must match its body (validation_failed, "This template needs 2 values.").
 */
export const SendStaffTemplateInput = z
  .object({
    template: z
      .object({
        name: z.string().regex(/^[a-z0-9_]{1,512}$/, "Choose a template"),
        language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Choose the template's language"),
        params: z.array(z.string().trim().min(1, "Fill in every value").max(WHATSAPP_TEXT_MAX)).max(20),
      })
      .strict(),
  })
  .strict();
export type SendStaffTemplateInput = z.infer<typeof SendStaffTemplateInput>;

/** Result of POST /api/conversations/:id/messages. "accepted" means Meta took it; delivery arrives later as a status. */
export interface SendStaffReplyResult extends SendResult {
  /** The stored messages row; the inbox receives it through realtime. */
  messageId: string;
  status: "accepted";
}

// Templates. Names are versioned (`reminder_24h_v1`); a change is a new version, never an edit in
// place. English and Tamil versions; utility or marketing category (docs/handover.md, module 5 and 7).
export const TEMPLATE_CATEGORIES = ["utility", "marketing"] as const;
export const TEMPLATE_LANGUAGES = ["en", "ta"] as const;
/** Meta's limit for a template body. */
export const TEMPLATE_BODY_MAX = 1024;

/** The distinct `{{n}}` variables in a template body, sorted by number. */
export function templateVariables(body: string): number[] {
  const nums = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** Meta allows at most three buttons on a template. */
export const TEMPLATE_BUTTONS_MAX = 3;
/** Meta's limits for header text, footer and button text (confirmed, docs/shared-types.md section 9). */
export const TEMPLATE_HEADER_MAX = 60;
export const TEMPLATE_FOOTER_MAX = 60;
export const TEMPLATE_BUTTON_TEXT_MAX = 25;

const buttonText = z
  .string()
  .trim()
  .min(1, "Add the button text")
  .max(TEMPLATE_BUTTON_TEXT_MAX, `Keep it under ${TEMPLATE_BUTTON_TEXT_MAX} characters`);

export const TemplateButton = z.discriminatedUnion("type", [
  z.object({ type: z.literal("quick_reply"), text: buttonText }),
  z.object({
    type: z.literal("url"),
    text: buttonText,
    url: z.url({ protocol: /^https?$/, error: "Enter a web address starting with https://" }),
  }),
  z.object({
    type: z.literal("phone_number"),
    text: buttonText,
    phoneNumber: PhoneInput,
  }),
]);
export type TemplateButton = z.infer<typeof TemplateButton>;
export const TEMPLATE_BUTTON_TYPES = ["quick_reply", "url", "phone_number"] as const satisfies readonly TemplateButton["type"][];

/** Meta rejects a template whose body starts or ends with a variable. */
const EDGE_VARIABLE = /^\{\{\d+\}\}|\{\{\d+\}\}$/;

export const CreateTemplateInput = z
  .object({
    name: z
      .string()
      .trim()
      .regex(
        /^[a-z][a-z0-9_]*_v[1-9]\d*$/,
        "Use lowercase letters, numbers and underscores, ending in a version like _v1",
      )
      .max(512),
    category: z.enum(TEMPLATE_CATEGORIES),
    language: z.enum(TEMPLATE_LANGUAGES),
    body: z
      .string()
      .trim()
      .min(1, "Write the message")
      .max(TEMPLATE_BODY_MAX, `Keep it under ${TEMPLATE_BODY_MAX} characters`),
    /** One sample value per variable, in order: examples[0] is {{1}}. */
    examples: z.array(z.string().trim().min(1, "Add a sample value")),
    header: z.string().trim().min(1).max(TEMPLATE_HEADER_MAX, `Keep it under ${TEMPLATE_HEADER_MAX} characters`).optional(),
    footer: z.string().trim().min(1).max(TEMPLATE_FOOTER_MAX, `Keep it under ${TEMPLATE_FOOTER_MAX} characters`).optional(),
    buttons: z.array(TemplateButton).max(TEMPLATE_BUTTONS_MAX, `Add up to ${TEMPLATE_BUTTONS_MAX} buttons`).optional(),
    /** Which WhatsApp number to submit it on. Omitted: the backend uses the only active connection. */
    connectionId: z.guid().optional(),
  })
  .superRefine((t, ctx) => {
    const vars = templateVariables(t.body);
    vars.forEach((n, i) => {
      if (n !== i + 1) {
        ctx.addIssue({ code: "custom", path: ["body"], message: "Number variables in order: {{1}}, {{2}}, …" });
      }
    });
    if (EDGE_VARIABLE.test(t.body)) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "Start and end the message with words, not a variable" });
    }
    if (t.examples.length !== vars.length) {
      ctx.addIssue({ code: "custom", path: ["examples"], message: "Add one sample value for each variable" });
    }
  });
export type CreateTemplateInput = z.infer<typeof CreateTemplateInput>;

export interface CreateTemplateResult {
  id: string;
  name: string;
  language: (typeof TEMPLATE_LANGUAGES)[number];
  /** "pending": submitted to Meta and waiting for review. "draft": saved, not submitted. */
  status: "pending" | "draft";
}

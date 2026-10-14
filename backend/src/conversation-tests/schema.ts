import { z } from "zod";
import { INJECTABLE_FAILURES } from "../lib/env";

// One scripted chat (tests/conversations/<pack>/*.yaml, docs/handover.md "Conversation test suite"). A chat is a
// business setup and a list of customer turns. Each turn can say what the MOCKED models answer (the default, used in CI)
// and what must be true afterwards. With --live the real models answer instead, so only `expect` is checked
// (not `mockOnly`): what the real model understood is the thing being tested.

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

const Extracted = z
  .object({
    intent: z.string().optional(),
    language: z.string().optional(),
    sentiment: z.string().optional(),
    asksIfHuman: z.boolean().optional(),
    notInterested: z.boolean().optional(),
    fields: z.record(z.string(), Scalar).optional(),
  })
  .strict();

const ReplyExpect = z
  .object({
    /** Exactly one AI reply goes out (true) or none does (false). Not checked when missing (the "at most one" rule is always checked). */
    sent: z.boolean().optional(),
    /** The reply is this fixed line, in this language: "fallback", "clarify", "handoff", "exit_question", ... */
    fixed: z.object({ key: z.enum(["fallback", "clarify", "handoff", "handoff_sorry", "voice_note", "stop_hint", "credits_holding", "opt_out_confirmation", "exit_question"]), language: z.enum(["en", "ta", "ta-en", "hi"]) }).strict().optional(),
    /** The titles of the reply buttons the message carried, in order ([] = it was plain text). */
    buttons: z.array(z.string()).optional(),
    contains: z.array(z.string()).optional(),
    /** Regular expressions (any letter case) the reply must each match: for wording a real model varies ("10 am", "10:00 am"). Use `contains` under `mockOnly` for the exact words of the mock. */
    matches: z
      .array(
        z.string().refine((p) => {
          try {
            new RegExp(p, "i");
            return true;
          } catch {
            return false;
          }
        }, "not a valid regular expression"),
      )
      .optional(),
    notContains: z.array(z.string()).optional(),
    /** The privacy notice is on the reply (true) or not (false). */
    notice: z.boolean().optional(),
  })
  .strict();

const Expect = z
  .object({
    /** The message was a STOP phrase: opted out before the model reads anything. */
    stop: z.boolean().optional(),
    extracted: Extracted.optional(),
    reply: ReplyExpect.optional(),
    /** Every price in the reply is in the knowledge-base facts the reply was given (the post-check, from outside). */
    noInventedPrice: z.boolean().optional(),
    /** The reply step's table row, e.g. "answered_from_kb". */
    case: z.string().optional(),
    optedOut: z.boolean().optional(),
    consent: z.array(z.object({ event: z.string(), source: z.string() }).strict()).optional(),
    handoff: z.union([z.null(), z.object({ trigger: z.string(), priority: z.enum(["high", "normal"]) }).strict()]).optional(),
    mode: z.enum(["ai", "human"]).optional(),
    leadStage: z.string().optional(),
    leadFields: z.record(z.string(), Scalar).optional(),
    /** What the code worked out about the lead (hot, warm, cold or disqualified) and its score. */
    /** Staff were told this turn that the lead turned hot (a lead.hot event), or were not. The chat stays with the AI either way. */
    hotLead: z.boolean().optional(),
    /** Staff were told this turn that a voice note is waiting (a voice_note.received event), or were not. */
    voiceNoteAlert: z.boolean().optional(),
    /** Staff were reminded this turn to record an area the business has no sites in (a staff alert), or were not. */
    areaReminder: z.boolean().optional(),
    /** Staff were told this turn that a customer with no booking on record asked to cancel or move one (a staff alert, before the reply; no handover, no mode change), or were not. */
    bookingChangeReminder: z.boolean().optional(),
    leadTemperature: z.string().optional(),
    leadScore: z.number().optional(),
    /** The calendar after this turn (needs the chat's `booking`): the start of every confirmed booking, soonest first, and how many were cancelled so far. */
    calendar: z.object({ confirmed: z.array(z.string()).optional(), cancelled: z.number().int().min(0).optional() }).strict().optional(),
    /** How many messages went to the customer this turn through notify.send (the AI reply). Not checked when missing. */
    aiReplies: z.number().int().min(0).optional(),
    /** One confirmation through the system notice. */
    confirmations: z.number().int().min(0).optional(),
  })
  .strict();

const Turn = z
  .object({
    customer: z.string().min(1),
    /** The customer tapped a reply button or list row with this id (the text is then its title): the inbound message has kind `interactive` and `meta.buttonId`. */
    tap: z.string().min(1).optional(),
    /** The customer sent a voice note: an audio message with no words. `customer` is only the label shown in a failure. */
    voice: z.literal(true).optional(),
    mock: z
      .object({
        /** What the mocked extraction model returns; missing keys get quiet defaults (an English question, 0.9). */
        extraction: z.record(z.string(), z.unknown()).optional(),
        /** What the mocked reply model writes, one text per attempt (a second one is the answer to a post-check rejection). */
        reply: z.union([z.string(), z.array(z.string())]).optional(),
        /** The knowledge base for this turn, instead of the chat's own: [] means no answer. */
        kb: z.array(z.string()).optional(),
        /** The business is out of credits this turn: notify.send refuses the reply (insufficient_credits) and spends nothing. */
        credits: z.literal("zero").optional(),
        /** The staff reminder for a cancel or move with no booking cannot be sent this turn (the reply then says nobody was told). */
        bookingReminder: z.literal("fails").optional(),
        /**
         * Failures injected this turn (lib/failure-injection.ts), as they would happen for real: llm_timeout (every model
         * call times out), llm_bad_json (the extraction answers a cut-off object, every try), whatsapp_send_error (WhatsApp
         * refuses the reply) or whatsapp_send_timeout (WhatsApp never answers; the reply may have gone, so never resend).
         */
        inject: z.array(z.enum(INJECTABLE_FAILURES)).min(1).optional(),
      })
      .strict()
      .optional(),
    expect: Expect.optional(),
    /** Checked only with the mocked models: what the code does with a given reading. */
    mockOnly: Expect.optional(),
  })
  .strict()
  .refine((t) => Object.keys(t.expect ?? {}).length + Object.keys(t.mockOnly ?? {}).length > 0, { message: "a turn must assert something (expect or mockOnly)" });

/** Switches on qualifying and booking for a chat, with a calendar of its own. Without it a chat runs as before. */
const BookingSetup = z
  .object({
    /** The business's clock (ISO), fixed so "tomorrow evening" does not depend on when the test runs. */
    now: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a time"),
    timeZone: z.string().default("Asia/Kolkata"),
    /** How many active services the business has. Exactly one is the only case the assistant books on its own. */
    services: z.number().int().min(0).max(3).default(1),
    /** The business's catalog: the price bands and areas the pack's scoring compares a customer with. */
    catalog: z
      .array(z.object({ type: z.string().default("property"), priceFrom: z.number().nullable().default(null), attributes: z.record(z.string(), z.unknown()).default({}) }).strict())
      .default([]),
    /** Free times in the calendar (ISO UTC starts; each lasts an hour). */
    slots: z.array(z.string()).default([]),
    /** Times someone else takes first, once, when the customer chooses one of them. */
    takenWhenChosen: z.array(z.string()).default([]),
    /** A confirmed booking the customer already has (ISO UTC start). */
    existing: z.string().optional(),
  })
  .strict();

export const Chat = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    pack: z.string().default("real-estate"),
    /** Raja's list marks these as needing a native speaker's check before they are final test data. */
    needsNativeCheck: z.boolean().optional(),
    /** tenants.agent_settings, as the dashboard saves it. */
    settings: z.record(z.string(), z.unknown()).default({}),
    contact: z.object({ language: z.string().nullable().default(null), alreadySawNotice: z.boolean().default(true) }).strict().default({ language: null, alreadySawNotice: true }),
    /** The knowledge-base chunks found for a question, unless a turn says otherwise. */
    kb: z.array(z.string()).default([]),
    booking: BookingSetup.optional(),
    turns: z.array(Turn).min(1),
  })
  .strict();
export type Chat = z.infer<typeof Chat>;
export type ChatTurn = z.infer<typeof Turn>;
export type TurnExpect = z.infer<typeof Expect>;

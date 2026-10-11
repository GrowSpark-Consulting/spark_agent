import type { InboundMessage, StatusUpdate } from "@pakka/types";
import { z } from "zod";
import { stripUnsafeCharacters } from "../../lib/text";
import { normalizeE164 } from "./phone";

// Turns a VERIFIED, already JSON-parsed WhatsApp webhook body into what the route needs. It checks no
// signature (signature.ts does that on the raw bytes) and never throws: anything malformed or unknown
// ends up in `ignored` with a reason. Ignored items carry no phone numbers, names or message text.
//
// Field names follow Meta's webhook reference. Marked "unconfirmed" below: the shape of interactive
// replies, and anything about template language or timestamps, which this file deliberately does not read.

/** Where an item came from, so the route can find the connection (see routing.ts). */
export type Routing = { phoneNumberId: string; wabaId: string };

/** An inbound customer message before the route adds tenantId and channelId. providerMsgId is the wamid. */
export type ParsedMessage = Omit<InboundMessage, "tenantId" | "channelId" | "type"> &
  Routing & {
    /** "unsupported" is parser-local: it is not in the shared InboundMessageType. */
    type: InboundMessage["type"] | "unsupported";
    /** Meta's own type word for an unsupported message (for example "sticker"). */
    unsupportedType?: string;
  };

/** A delivery state. Dedupe key: `${providerMsgId}:${status}`, because one message gets several. */
export type ParsedStatus = Omit<StatusUpdate, "error"> &
  Routing & { error?: { code: number; title?: string; message: string } };

/** From message_template_status_update. `event` is Meta's event name, passed unchanged to set_template_status. */
export const TemplateStatusUpdate = z.object({
  wabaId: z.string().min(1),
  metaTemplateId: z.string().min(1), // Meta sends an integer; whatsapp_templates.meta_template_id is text
  name: z.string().min(1),
  language: z.string().min(1).optional(), // never filled: Meta's field name is unconfirmed
  event: z.string().min(1),
  reason: z.string().optional(), // Meta's reason, possibly "NONE": cleaned and cut to REASON_MAX_CHARS before it gets here
  timestamp: z.iso.datetime({ offset: true }).optional(), // never filled: Meta's field name is unconfirmed
});
export type TemplateStatusUpdate = z.infer<typeof TemplateStatusUpdate>;

/** From phone_number_quality_update. Meta's field names are unconfirmed, so only plain identifiers are kept. */
export const QualityUpdate = z.object({
  wabaId: z.string().min(1),
  event: z.string().min(1), // UPGRADE, DOWNGRADE, ONBOARDING, ...: a plain word, or "unknown"
  currentLimit: z.string().optional(), // for example TIER_1K
  qualityRating: z.string().optional(), // GREEN, YELLOW, RED, if the payload carries one
});
export type QualityUpdate = z.infer<typeof QualityUpdate>;

/** From account_update. Only the event's name is kept: it is logged, nothing else is read. */
export const AccountUpdate = z.object({ wabaId: z.string().min(1), event: z.string().min(1) });
export type AccountUpdate = z.infer<typeof AccountUpdate>;

/** A template's rejection reason is stored on the template: Meta's words, cleaned and short. */
export const REASON_MAX_CHARS = 500;

export type IgnoredReason =
  | "unsupported_field" // a webhook field we do not handle (history, app state, anything new)
  | "unsupported_status" // for example "played"
  | "invalid_item" // failed validation: bad number, bad timestamp, unsafe template id
  | "malformed_payload";

export type IgnoredItem = {
  field: string;
  reason: IgnoredReason;
  wabaId?: string;
  /** A wamid, only on invalid_item. */
  ref?: string;
};

/**
 * From smb_message_echoes (coexistence): the business owner replied to a customer from the WhatsApp Business APP on their phone, and Meta sends a copy.
 * Not a customer's message. The shape is from Meta's coexistence documentation as known today and is UNCONFIRMED: only the text body is read, and
 * anything else is kept as an echo with no words. Live after Embedded Signup is approved.
 */
export type ParsedEcho = Routing & {
  /** The wamid of the owner's message: the dedupe key. */
  providerMsgId: string;
  /** The customer it was sent to, E.164. */
  customerPhone: string;
  sentAt: string;
  kind: "text" | "unsupported";
  text?: string;
  /** Meta's own type word when the echo is not text (for example "image"). */
  unsupportedType?: string;
};

export type ParseResult = {
  messages: ParsedMessage[];
  statuses: ParsedStatus[];
  templateStatuses: TemplateStatusUpdate[];
  qualityUpdates: QualityUpdate[];
  accountUpdates: AccountUpdate[];
  echoes: ParsedEcho[];
  ignored: IgnoredItem[];
};

const str = z.string();
const nonEmpty = z.string().min(1);

const Envelope = z.looseObject({ entry: z.array(z.unknown()) });
const Entry = z.looseObject({ id: nonEmpty, changes: z.array(z.unknown()).optional() });
const Change = z.looseObject({ field: str, value: z.unknown() });

const MessagesValue = z.looseObject({
  metadata: z.looseObject({ phone_number_id: nonEmpty }),
  contacts: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});
const Contact = z.looseObject({ wa_id: nonEmpty, profile: z.looseObject({ name: str }).optional() });
const EchoesValue = z.looseObject({ metadata: z.looseObject({ phone_number_id: nonEmpty }), message_echoes: z.unknown().optional() });
const EchoBase = z.looseObject({ id: nonEmpty, to: str, type: str });

const MessageBase = z.looseObject({ id: nonEmpty, from: str, type: str });
const TextBody = z.looseObject({ text: z.looseObject({ body: str }) });
const Reply = z.looseObject({ id: nonEmpty, title: str });
// Interactive replies: shape assumed from the docs, unconfirmed.
const Interactive = z.looseObject({
  interactive: z.union([
    z.looseObject({ type: z.literal("button_reply"), button_reply: Reply }),
    z.looseObject({ type: z.literal("list_reply"), list_reply: Reply }),
  ]),
});
const Media = z.looseObject({ id: nonEmpty, mime_type: nonEmpty, caption: str.optional().catch(undefined) });
const Location = z.looseObject({
  location: z.looseObject({
    latitude: z.number(),
    longitude: z.number(),
    name: str.optional().catch(undefined),
    address: str.optional().catch(undefined),
  }),
});

const StatusBase = z.looseObject({ id: nonEmpty, status: str, recipient_id: z.unknown().optional(), errors: z.array(z.unknown()).optional() });
const StatusError = z.looseObject({ code: z.number().int(), title: str.optional().catch(undefined), message: str.optional().catch(undefined) });
const DELIVERY_STATUSES = ["sent", "delivered", "read", "failed"] as const;

const TemplateValue = z.looseObject({
  event: nonEmpty,
  message_template_id: z.union([nonEmpty, z.number()]),
  message_template_name: nonEmpty,
  reason: str.optional().catch(undefined),
});

/** Names that come from the payload are passed on only if they look like a plain identifier. */
function safeWord(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "unknown";
}

/** Unix seconds (a number or a string of digits) to an ISO string; null for anything else. */
function toIso(value: unknown): string | null {
  let seconds: number;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "string" && /^\d{1,15}$/.test(value)) seconds = Number(value);
  else return null;
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function refOf(id: unknown): string | undefined {
  return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : undefined;
}

function invalid(field: string, wabaId: string, ref?: string): IgnoredItem {
  return { field, reason: "invalid_item", wabaId, ...(ref !== undefined && { ref }) };
}

function parseMessage(
  raw: unknown,
  routing: Routing,
  names: Map<string, string>,
): ParsedMessage | IgnoredItem {
  const base = MessageBase.safeParse(raw);
  if (!base.success) return invalid("messages", routing.wabaId);
  const item = base.data;
  const from = normalizeE164(item.from);
  const timestamp = toIso(item.timestamp);
  if (from === null || timestamp === null) return invalid("messages", routing.wabaId, refOf(item.id));

  const name = names.get(item.from);
  const common = {
    providerMsgId: item.id,
    from,
    timestamp,
    ...(name !== undefined && { contactName: name }),
    ...routing,
  };
  // A message we cannot map is kept, never dropped, so the customer's message is not lost.
  const unsupported = (): ParsedMessage => ({ ...common, type: "unsupported", unsupportedType: safeWord(item.type) });

  switch (item.type) {
    case "text": {
      const parsed = TextBody.safeParse(raw);
      return parsed.success ? { ...common, type: "text", text: parsed.data.text.body } : unsupported();
    }
    case "interactive": {
      const parsed = Interactive.safeParse(raw);
      if (!parsed.success) return unsupported();
      const { interactive } = parsed.data;
      const reply = interactive.type === "button_reply" ? interactive.button_reply : interactive.list_reply;
      return { ...common, type: "interactive", buttonId: reply.id, text: reply.title };
    }
    case "image":
    case "audio":
    case "document": {
      const parsed = z.looseObject({ [item.type]: Media }).safeParse(raw);
      if (!parsed.success) return unsupported();
      const media = parsed.data[item.type] as z.infer<typeof Media>;
      return {
        ...common,
        type: item.type,
        media: { id: media.id, mime: media.mime_type },
        ...(item.type !== "audio" && media.caption ? { text: media.caption } : {}),
      };
    }
    case "location": {
      const parsed = Location.safeParse(raw);
      if (!parsed.success) return unsupported();
      const { latitude, longitude, name: place, address } = parsed.data.location;
      const text = [`${latitude},${longitude}`, place, address].filter(Boolean).join(" ");
      return { ...common, type: "location", text };
    }
    default:
      return unsupported();
  }
}

function parseStatus(raw: unknown, routing: Routing): ParsedStatus | IgnoredItem {
  const base = StatusBase.safeParse(raw);
  if (!base.success) return invalid("statuses", routing.wabaId);
  const item = base.data;
  const status = DELIVERY_STATUSES.find((s) => s === item.status);
  if (!status) return { field: "statuses", reason: "unsupported_status", wabaId: routing.wabaId };
  const timestamp = toIso((raw as { timestamp?: unknown }).timestamp);
  if (timestamp === null) return invalid("statuses", routing.wabaId, refOf(item.id));

  const recipient = normalizeE164(item.recipient_id);
  const firstError = item.errors?.map((e) => StatusError.safeParse(e)).find((r) => r.success);
  const error = firstError?.success
    ? {
        code: firstError.data.code,
        ...(firstError.data.title !== undefined && { title: firstError.data.title }),
        message: firstError.data.message ?? firstError.data.title ?? "",
      }
    : undefined;
  return {
    providerMsgId: item.id,
    status,
    timestamp,
    ...(recipient !== null && { recipient }),
    ...(error && { error }),
    ...routing,
  };
}

function parseTemplateStatus(value: unknown, wabaId: string): TemplateStatusUpdate | IgnoredItem {
  const field = "message_template_status_update";
  const parsed = TemplateValue.safeParse(value);
  if (!parsed.success) return invalid(field, wabaId);
  const v = parsed.data;
  // Meta sends an integer. One beyond the safe range was already rounded by JSON.parse: do not pass it on.
  const id = typeof v.message_template_id === "number" ? (Number.isSafeInteger(v.message_template_id) ? String(v.message_template_id) : null) : v.message_template_id;
  if (id === null) return invalid(field, wabaId);
  const update = TemplateStatusUpdate.safeParse({
    wabaId,
    metaTemplateId: id,
    name: v.message_template_name,
    event: v.event,
    ...(v.reason !== undefined && { reason: [...stripUnsafeCharacters(v.reason)].slice(0, REASON_MAX_CHARS).join("") }),
  });
  return update.success ? update.data : invalid(field, wabaId);
}

const PlainObject = z.looseObject({});
/** A plain identifier (upper or lower case letters, digits, _ . -) or undefined: nothing else from a payload is kept. */
const plain = (value: unknown): string | undefined => (typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined);

function parseQuality(value: unknown, wabaId: string): QualityUpdate | IgnoredItem {
  const field = "phone_number_quality_update";
  const parsed = PlainObject.safeParse(value);
  if (!parsed.success) return invalid(field, wabaId);
  const v = parsed.data as Record<string, unknown>;
  const qualityRating = plain(v.quality_rating) ?? plain(v.current_quality_rating);
  return { wabaId, event: plain(v.event) ?? "unknown", ...(plain(v.current_limit) !== undefined && { currentLimit: plain(v.current_limit) }), ...(qualityRating !== undefined && { qualityRating }) };
}

function parseAccount(value: unknown, wabaId: string): AccountUpdate | IgnoredItem {
  const parsed = PlainObject.safeParse(value);
  if (!parsed.success) return invalid("account_update", wabaId);
  return { wabaId, event: plain((parsed.data as Record<string, unknown>).event) ?? "unknown" };
}

/** One echo of the owner's reply, or why it was ignored. Keeps the words only of a plain text body. */
function parseEcho(raw: unknown, routing: Routing): ParsedEcho | IgnoredItem {
  const field = "smb_message_echoes";
  const base = EchoBase.safeParse(raw);
  if (!base.success) return invalid(field, routing.wabaId);
  const item = base.data;
  const customerPhone = normalizeE164(item.to);
  const sentAt = toIso((raw as Record<string, unknown>).timestamp);
  if (customerPhone === null || sentAt === null) return invalid(field, routing.wabaId, refOf(item.id));
  const common = { providerMsgId: item.id, customerPhone, sentAt, ...routing };
  if (item.type === "text") {
    const text = TextBody.safeParse(raw);
    if (text.success) return { ...common, kind: "text", text: text.data.text.body };
  }
  return { ...common, kind: "unsupported", unsupportedType: safeWord(item.type) };
}

function parseEchoes(value: unknown, wabaId: string, result: ParseResult): void {
  const field = "smb_message_echoes";
  const parsed = EchoesValue.safeParse(value);
  if (!parsed.success) {
    result.ignored.push({ field, reason: "malformed_payload", wabaId });
    return;
  }
  const routing: Routing = { phoneNumberId: parsed.data.metadata.phone_number_id, wabaId };
  const echoes = parsed.data.message_echoes;
  if (echoes === undefined || echoes === null) return;
  if (!Array.isArray(echoes)) {
    result.ignored.push({ field, reason: "malformed_payload", wabaId });
    return;
  }
  for (const raw of echoes) {
    try {
      const item = parseEcho(raw, routing);
      if ("providerMsgId" in item && "customerPhone" in item) result.echoes.push(item);
      else result.ignored.push(item);
    } catch {
      result.ignored.push(invalid(field, wabaId));
    }
  }
}

function parseChange(rawChange: unknown, wabaId: string, result: ParseResult): void {
  const change = Change.safeParse(rawChange);
  if (!change.success) {
    result.ignored.push({ field: "changes", reason: "malformed_payload", wabaId });
    return;
  }
  const { field, value } = change.data;

  if (field === "message_template_status_update") {
    const item = parseTemplateStatus(value, wabaId);
    if ("event" in item) result.templateStatuses.push(item);
    else result.ignored.push(item);
    return;
  }
  if (field === "phone_number_quality_update") {
    const item = parseQuality(value, wabaId);
    if ("event" in item) result.qualityUpdates.push(item);
    else result.ignored.push(item);
    return;
  }
  if (field === "account_update") {
    const item = parseAccount(value, wabaId);
    if ("event" in item) result.accountUpdates.push(item);
    else result.ignored.push(item);
    return;
  }
  if (field === "smb_message_echoes") {
    parseEchoes(value, wabaId, result);
    return;
  }
  if (field !== "messages") {
    // Coexistence history, app state and anything new: counted by name, shape not guessed.
    result.ignored.push({ field: safeWord(field), reason: "unsupported_field", wabaId });
    return;
  }

  const parsed = MessagesValue.safeParse(value);
  if (!parsed.success) {
    result.ignored.push({ field, reason: "malformed_payload", wabaId });
    return;
  }
  const routing: Routing = { phoneNumberId: parsed.data.metadata.phone_number_id, wabaId };
  const names = new Map<string, string>();
  for (const rawContact of parsed.data.contacts ?? []) {
    const contact = Contact.safeParse(rawContact);
    if (contact.success && contact.data.profile) names.set(contact.data.wa_id, contact.data.profile.name);
  }

  for (const raw of parsed.data.messages ?? []) {
    try {
      const item = parseMessage(raw, routing, names);
      if ("providerMsgId" in item) result.messages.push(item);
      else result.ignored.push(item);
    } catch {
      result.ignored.push(invalid("messages", wabaId));
    }
  }
  for (const raw of parsed.data.statuses ?? []) {
    try {
      const item = parseStatus(raw, routing);
      if ("providerMsgId" in item) result.statuses.push(item);
      else result.ignored.push(item);
    } catch {
      result.ignored.push(invalid("statuses", wabaId));
    }
  }
}

/** Never throws. Takes a verified, already-parsed body. No de-duplication: the wamid is the dedupe key. */
export function parseWebhook(body: unknown): ParseResult {
  const result: ParseResult = { messages: [], statuses: [], templateStatuses: [], qualityUpdates: [], accountUpdates: [], echoes: [], ignored: [] };
  try {
    const envelope = Envelope.safeParse(body);
    if (!envelope.success) {
      result.ignored.push({ field: "payload", reason: "malformed_payload" });
      return result;
    }
    for (const rawEntry of envelope.data.entry) {
      try {
        const entry = Entry.safeParse(rawEntry);
        if (!entry.success) {
          result.ignored.push({ field: "entry", reason: "malformed_payload" });
          continue;
        }
        for (const change of entry.data.changes ?? []) {
          try {
            parseChange(change, entry.data.id, result);
          } catch {
            result.ignored.push({ field: "changes", reason: "malformed_payload", wabaId: entry.data.id });
          }
        }
      } catch {
        result.ignored.push({ field: "entry", reason: "malformed_payload" });
      }
    }
  } catch {
    return { messages: [], statuses: [], templateStatuses: [], qualityUpdates: [], accountUpdates: [], echoes: [], ignored: [{ field: "payload", reason: "malformed_payload" }] };
  }
  return result;
}

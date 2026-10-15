import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// The inbox read path (docs/dashboard-screen-contracts.md, Inbox). The browser reads conversations,
// contacts, handoffs and messages as the signed-in member: row-level security (is_member) is the
// boundary, and every query also filters by the session's tenant id. Rows are parsed with Zod and
// mapped to the view model below, so screens never handle raw database rows.
//
// Known limits, each shown honestly in the UI rather than filled with made-up data:
//   * No unread tracking exists (no column or table), so there are no unread counts.
//   * No staff names (messages has no user column, there is no profile table): staff bubbles say "Staff".
//   * No persona name yet (tenants.agent_settings has no agreed shape): AI bubbles say "AI".
//   * No conversation → lead link, so no score chip in the list (the lead card finds the lead through the contact).
//   * The list loads the newest CONVERSATION_LIMIT conversations by creation time and is sorted by
//     each one's newest loaded message. Migration 0010 adds conversations.last_message_at; once it is
//     applied everywhere, order and page by that column in the query instead.
//   * Media files aren't downloaded: messages.media holds Meta's media id and mime type only
//     (docs/task-notes/2026-10-08-feat-agent-webhook-post.md), so photos, documents and voice
//     messages show a placeholder, never a preview, a player or a link.

export const CONVERSATION_LIMIT = 200;
/** Newest messages loaded per chat; older history needs paging (not built). */
export const MESSAGE_LIMIT = 300;
const WINDOW_MS = 24 * 60 * 60 * 1000;

// Rows -------------------------------------------------------------------------------------------

/** Postgres timestamps from PostgREST ("…T…+00:00") and Realtime ("… …+00") as ISO 8601 UTC. */
export const Timestamp = z.string().transform((value, ctx) => {
  let s = value.trim().replace(" ", "T");
  if (/[+-]\d\d$/.test(s)) s += ":00";
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    ctx.addIssue({ code: "custom", message: "must be a timestamp" });
    return z.NEVER;
  }
  return new Date(ms).toISOString();
});

export const Sender = z.enum(["customer", "ai", "staff", "system"]);
export type Sender = z.infer<typeof Sender>;
export const ConversationMode = z.enum(["ai", "human", "external"]);
export type ConversationMode = z.infer<typeof ConversationMode>;

/**
 * messages.kind and messages.meta (migration 0013): what an inbound message is, and what doesn't fit a
 * column. Null on outbound rows and rows from before 0013. Kept loose (any string) so a kind added
 * later is shown from its body rather than failing the whole read.
 */
const Kind = z.string().nullable().optional();
const Meta = z.unknown().optional();

const LatestMessageRow = z.object({
  id: z.guid(),
  sender: Sender,
  kind: Kind,
  body: z.string().nullable(),
  media: z.unknown().optional(),
  meta: Meta,
  template_name: z.string().nullable(),
  created_at: Timestamp,
});

const OpenHandoffRow = z.object({ id: z.guid(), trigger: z.string() });

export const ConversationListRow = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  contact_id: z.guid(),
  mode: ConversationMode,
  status: z.string(),
  last_customer_msg_at: Timestamp.nullable(),
  created_at: Timestamp,
  contacts: z.object({ name: z.string().nullable(), phone: z.string(), language: z.string().nullable() }).nullable(),
  handoffs: z.array(OpenHandoffRow),
  messages: z.array(LatestMessageRow),
});
export type ConversationListRow = z.input<typeof ConversationListRow>;

export const MessageRow = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  conversation_id: z.guid(),
  direction: z.enum(["in", "out"]),
  sender: Sender,
  kind: Kind,
  body: z.string().nullable(),
  media: z.unknown().optional(),
  meta: Meta,
  template_name: z.string().nullable(),
  delivery_status: z.string().nullable(),
  created_at: Timestamp,
});
export type MessageRow = z.input<typeof MessageRow>;

/** A conversations row as Realtime sends it (no embedded contact). */
export const ConversationChangeRow = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  mode: ConversationMode,
  status: z.string(),
  last_customer_msg_at: Timestamp.nullable(),
});

export const HandoffChangeRow = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  conversation_id: z.guid(),
  trigger: z.string(),
  resolved_at: Timestamp.nullable(),
});

const CONVERSATION_COLUMNS =
  "id, tenant_id, contact_id, mode, status, last_customer_msg_at, created_at, " +
  "contacts (name, phone, language), handoffs (id, trigger), " +
  "messages (id, sender, kind, body, media, meta, template_name, created_at)";
const MESSAGE_COLUMNS =
  "id, tenant_id, conversation_id, direction, sender, kind, body, media, meta, template_name, delivery_status, created_at";

// View model -------------------------------------------------------------------------------------

export interface Attachment {
  /** Short label for the file tile, e.g. "PDF" or "IMG". */
  label: string;
  name: string;
  /** A second line under the name: why the file can't be opened, or a location's coordinates. */
  note?: string;
}

export interface LastMessage {
  id: string;
  sender: Exclude<Sender, "system">;
  preview: string;
  at: string;
}

export interface ConversationSummary {
  id: string;
  /** conversations.contact_id: the customer, and through leads.contact_id their lead. */
  contactId: string;
  /** Contact name, or the masked number when the contact has no name. */
  name: string;
  firstName: string;
  initials: string;
  phoneMasked: string;
  /** For search only; never rendered (RLS already lets members read contacts.phone). */
  phoneDigits: string;
  language: string | null;
  mode: ConversationMode;
  status: string;
  /** Unresolved handoffs; any one of them means the chat needs a person. */
  openHandoffs: { id: string; trigger: string }[];
  lastMessage: LastMessage | null;
  lastCustomerMsgAt: string | null;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  sender: Sender;
  /** messages.kind; null on outbound rows and rows from before migration 0013. */
  kind: string | null;
  body: string | null;
  templateName: string | null;
  attachment: Attachment | null;
  /** What the bubble shows under the attachment, if anything (see describeMessage). */
  text: string | null;
  /** The text is ours (e.g. "Message type not supported"), not the customer's words. */
  textIsNotice: boolean;
  /** For the conversation list, without the sender prefix. */
  preview: string;
  deliveryStatus: string | null;
  createdAt: string;
}

export type InboxTag = "needs_human" | "ai" | "human" | "external";
export type InboxFilter = "all" | "ai" | "needs_human";

/** Needs human = an open handoff; otherwise the conversation's own mode. */
export function conversationTag(c: Pick<ConversationSummary, "mode" | "openHandoffs">): InboxTag {
  if (c.openHandoffs.length > 0) return "needs_human";
  return c.mode;
}

export function matchesFilter(c: ConversationSummary, filter: InboxFilter): boolean {
  const tag = conversationTag(c);
  if (filter === "ai") return tag === "ai";
  if (filter === "needs_human") return tag === "needs_human";
  return true;
}

/** "Search name or number": a name match, or digits found anywhere in the contact's number. */
export function matchesSearch(c: ConversationSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, "");
  return c.name.toLowerCase().includes(q) || (digits.length > 0 && c.phoneDigits.includes(digits));
}

// Mapping ----------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type MediaKind = "image" | "audio" | "document";

/** Tile labels for the document types customers usually send; others fall back to "DOC". */
const MIME_LABEL: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/vnd.ms-powerpoint": "PPT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "text/plain": "TXT",
  "text/csv": "CSV",
};

/** "audio/ogg; codecs=opus" → "audio/ogg". */
function baseMime(media: Record<string, unknown>): string | null {
  return stringField(media, "mime")?.split(";")[0].trim().toLowerCase() || null;
}

/**
 * Why the download job left a file out: it marks the row's media `skipped` or `unavailable` with one of these
 * reasons (backend/src/media/download.ts). Unknown reasons still get a plain line; the path is never shown.
 */
const MEDIA_LEFT_OUT: Record<string, string> = {
  too_big: "Too large to keep",
  type_not_allowed: "This file type isn't kept",
  media_gone: "WhatsApp no longer has this file",
  rejected: "WhatsApp wouldn't hand this file over",
  bad_answer: "WhatsApp wouldn't hand this file over",
};

function mediaLeftOut(record: Record<string, unknown>): string | null {
  const reason = stringField(record, "skipped") ?? stringField(record, "unavailable");
  return reason ? (MEDIA_LEFT_OUT[reason] ?? "Wasn't saved") : null;
}

/**
 * The placeholder for a photo, voice message or document (migration 0013's media `{ id, mime }`). The
 * file isn't downloaded, so nothing links to it. A file name is used when the row has one; #50 stores
 * none, so documents are named by type.
 */
function mediaAttachment(kind: MediaKind, media: unknown): Attachment {
  const record = isRecord(media) ? media : {};
  const leftOut = mediaLeftOut(record);
  const fileName = stringField(record, "name") ?? stringField(record, "filename");
  const ext = fileName ? /\.([a-z0-9]{2,4})$/i.exec(fileName)?.[1]?.toUpperCase() : undefined;
  const mime = baseMime(record);
  if (kind === "image") return { label: "IMG", name: fileName ?? "Photo", note: leftOut ?? "Can't be shown here yet" };
  if (kind === "audio") return { label: "AUD", name: "Voice message", note: leftOut ?? "Can't be played here yet" };
  return { label: ext ?? (mime ? MIME_LABEL[mime] : undefined) ?? "DOC", name: fileName ?? "Document", note: leftOut ?? "Can't be opened here yet" };
}

/**
 * Media on a row without a kind (outbound rows, or rows from before migration 0013). A kind or file
 * name in the media is used when present; otherwise the mime type decides what it is.
 */
export function attachmentOf(media: unknown): Attachment | null {
  if (!isRecord(media)) return null;
  const name = stringField(media, "name") ?? stringField(media, "filename") ?? stringField(media, "caption");
  const kind = stringField(media, "kind") ?? stringField(media, "type");
  if (!name && !kind) {
    const mime = baseMime(media);
    if (!mime) return null;
    return mediaAttachment(mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "document", media);
  }
  const ext = name && /\.([a-z0-9]{2,4})$/i.exec(name)?.[1];
  const label = (ext ?? (kind === "image" ? "img" : kind === "audio" ? "aud" : "doc")).toUpperCase();
  return { label, name: name ?? (kind ? kind[0].toUpperCase() + kind.slice(1) : "Attachment") };
}

/** A location's body as #50 writes it: "<lat>,<lng> <name> <address>" (name and address optional). */
export function locationOf(body: string | null): { coordinates: string; place: string | null } | null {
  const match = /^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:\s+([\s\S]*))?$/.exec(body ?? "");
  if (!match) return null;
  return { coordinates: `${match[1]}, ${match[2]}`, place: match[3]?.trim() || null };
}

/** "Message type not supported (sticker)": Meta's own word for the type, from meta.unsupportedType. */
export function unsupportedText(meta: unknown): string {
  const type = isRecord(meta) ? stringField(meta, "unsupportedType") : null;
  return type && type !== "unknown" && /^[a-z0-9_]{1,40}$/i.test(type) ? `Message type not supported (${type})` : "Message type not supported";
}

export interface MessageDisplay {
  attachment: Attachment | null;
  text: string | null;
  textIsNotice: boolean;
  preview: string;
}

/**
 * What a message looks like in its bubble and in the conversation list, by messages.kind (the shapes in
 * docs/task-notes/2026-10-08-feat-agent-webhook-post.md, section 6). Rows without a kind are shown as
 * before: the body or template, plus any media.
 */
export function describeMessage(m: {
  kind: string | null;
  body: string | null;
  media: unknown;
  meta: unknown;
  templateName: string | null;
}): MessageDisplay {
  const body = m.body?.trim() ? m.body : null;
  switch (m.kind) {
    case "image":
    case "audio":
    case "document": {
      // The body is the caption (#50 never sets one on audio).
      const attachment = mediaAttachment(m.kind, m.media);
      return { attachment, text: body, textIsNotice: false, preview: body ? `${attachment.name} · ${body.trim()}` : attachment.name };
    }
    case "location": {
      const location = locationOf(m.body);
      if (!location) return { attachment: { label: "LOC", name: "Location" }, text: body, textIsNotice: false, preview: "Location" };
      return {
        attachment: { label: "LOC", name: location.place ?? "Location", note: location.coordinates },
        text: null,
        textIsNotice: false,
        preview: location.place ? `Location · ${location.place}` : "Location",
      };
    }
    case "interactive": {
      // The body is the title of the button or list row the customer chose: their reply.
      const text = body ?? "Replied with a button";
      return { attachment: null, text, textIsNotice: !body, preview: text.trim() };
    }
    case "unsupported": {
      const text = unsupportedText(m.meta);
      return { attachment: null, text, textIsNotice: true, preview: text };
    }
    default: {
      const attachment = attachmentOf(m.media);
      const template = m.templateName ? `Template · ${m.templateName}` : null;
      // A kind added later that has nothing to show here: say so, rather than an empty bubble.
      if (m.kind && m.kind !== "text" && !body && !template && !attachment) {
        const notice = unsupportedText(null);
        return { attachment: null, text: notice, textIsNotice: true, preview: notice };
      }
      return {
        attachment,
        text: m.body ?? template,
        textIsNotice: false,
        preview: body?.trim() || template || attachment?.name || "",
      };
    }
  }
}

const PREFIX: Record<Exclude<Sender, "system">, string> = { customer: "", ai: "AI: ", staff: "Staff: " };

export function messagePreview(sender: Exclude<Sender, "system">, preview: string): string {
  return PREFIX[sender] + preview;
}

/**
 * For display only; the full number is never rendered. Indian numbers as in the prototype
 * ("+91 98xxx xxx21"). Others keep two leading and two trailing digits ("+97xxxxxxxx14"), because the
 * country code's length can't be told from the digits alone.
 */
export function maskPhoneForDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "Hidden number";
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+91 ${digits.slice(2, 4)}xxx xxx${digits.slice(-2)}`;
  }
  return `+${digits.slice(0, 2)}${"x".repeat(digits.length - 4)}${digits.slice(-2)}`;
}

export function initialsOf(name: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return "#";
  return words
    .slice(0, 2)
    .map((w) => [...w][0].toUpperCase())
    .join("");
}

/** "ta" → "Tamil"; unknown codes are shown as stored. */
export function languageName(code: string | null): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function toChatMessage(row: z.output<typeof MessageRow>): ChatMessage {
  const kind = row.kind ?? null;
  const display = describeMessage({ kind, body: row.body, media: row.media, meta: row.meta, templateName: row.template_name });
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    sender: row.sender,
    kind,
    body: row.body,
    templateName: row.template_name,
    ...display,
    deliveryStatus: row.delivery_status,
    createdAt: row.created_at,
  };
}

function toLastMessage(m: { id: string; sender: Sender; preview: string; at: string }): LastMessage | null {
  if (m.sender === "system") return null;
  return { id: m.id, sender: m.sender, preview: messagePreview(m.sender, m.preview), at: m.at };
}

export function toConversationSummary(row: z.output<typeof ConversationListRow>): ConversationSummary {
  const phone = row.contacts?.phone ?? "";
  const masked = maskPhoneForDisplay(phone);
  const contactName = row.contacts?.name?.trim() || null;
  const latest = row.messages[0];
  return {
    id: row.id,
    contactId: row.contact_id,
    name: contactName ?? masked,
    firstName: contactName ? contactName.split(/\s+/)[0] : "This customer",
    initials: initialsOf(contactName),
    phoneMasked: masked,
    phoneDigits: phone.replace(/\D/g, ""),
    language: languageName(row.contacts?.language ?? null),
    mode: row.mode,
    status: row.status,
    openHandoffs: row.handoffs.map((h) => ({ id: h.id, trigger: h.trigger })),
    lastMessage: latest
      ? toLastMessage({
          id: latest.id,
          sender: latest.sender,
          preview: describeMessage({
            kind: latest.kind ?? null,
            body: latest.body,
            media: latest.media,
            meta: latest.meta,
            templateName: latest.template_name,
          }).preview,
          at: latest.created_at,
        })
      : null,
    lastCustomerMsgAt: row.last_customer_msg_at,
    createdAt: row.created_at,
  };
}

// Ordering and live updates (pure, so they are unit-tested) ---------------------------------------

function activityAt(c: ConversationSummary): string {
  return c.lastMessage?.at ?? c.createdAt;
}

/** Newest activity first; ties broken by id so the order never depends on arrival order. */
export function sortConversations(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort((a, b) => activityAt(b).localeCompare(activityAt(a)) || b.id.localeCompare(a.id));
}

/** Oldest first by created_at, then id. Duplicates (same id) keep the latest version. */
export function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const next = messages.filter((m) => m.id !== message.id);
  next.push(message);
  return next.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * A message insert or update for the list. Returns null when the conversation isn't loaded (a new
 * chat): the caller refetches the list to get its contact.
 */
export function applyMessageToList(list: ConversationSummary[], m: ChatMessage): ConversationSummary[] | null {
  const target = list.find((c) => c.id === m.conversationId);
  if (!target) return null;
  if (m.sender === "system") return list;
  const current = target.lastMessage;
  const isNewer = !current || current.id === m.id || m.createdAt > current.at || (m.createdAt === current.at && m.id > current.id);
  if (!isNewer) return list;
  const lastMessage = toLastMessage({ ...m, at: m.createdAt });
  const lastCustomerMsgAt =
    m.sender === "customer" && (!target.lastCustomerMsgAt || m.createdAt > target.lastCustomerMsgAt)
      ? m.createdAt
      : target.lastCustomerMsgAt;
  return sortConversations(list.map((c) => (c.id === target.id ? { ...c, lastMessage, lastCustomerMsgAt } : c)));
}

/** A conversation update (mode, status, window). Returns null for a conversation not in the list. */
export function applyConversationChange(
  list: ConversationSummary[],
  row: z.output<typeof ConversationChangeRow>,
): ConversationSummary[] | null {
  if (!list.some((c) => c.id === row.id)) return null;
  return list.map((c) =>
    c.id === row.id ? { ...c, mode: row.mode, status: row.status, lastCustomerMsgAt: row.last_customer_msg_at } : c,
  );
}

/** A handoff opened or resolved. Returns null for a conversation not in the list. */
export function applyHandoffChange(
  list: ConversationSummary[],
  row: z.output<typeof HandoffChangeRow>,
): ConversationSummary[] | null {
  if (!list.some((c) => c.id === row.conversation_id)) return null;
  return list.map((c) => {
    if (c.id !== row.conversation_id) return c;
    const others = c.openHandoffs.filter((h) => h.id !== row.id);
    return { ...c, openHandoffs: row.resolved_at ? others : [...others, { id: row.id, trigger: row.trigger }] };
  });
}

/**
 * Orders overlapping reads of one piece of state (the list, or one chat). Reads overlap routinely: the
 * first load and the resync after subscribing run together, and live changes keep arriving. Only the
 * newest read's result is used, so an older one finishing late can't overwrite it; and live changes
 * that arrived while that read was in flight are replayed on top, so its snapshot can't drop them.
 */
export class ReadSequencer<T> {
  private seq = 0;
  private inFlight = false;
  private pending: ((value: T) => T)[] = [];

  /** Call when a read starts; pass the returned number to finish() or fail(). */
  start(): number {
    this.seq += 1;
    this.inFlight = true;
    this.pending = [];
    return this.seq;
  }

  /** The value to show, or null when a newer read has started since (ignore this result). */
  finish(seq: number, value: T): T | null {
    if (seq !== this.seq) return null;
    const result = this.pending.reduce((acc, change) => change(acc), value);
    this.inFlight = false;
    this.pending = [];
    return result;
  }

  /** True when this was the newest read, so its error should be shown. */
  fail(seq: number): boolean {
    if (seq !== this.seq) return false;
    this.inFlight = false;
    this.pending = [];
    return true;
  }

  /** A live change already applied to the screen; kept for replay if a read is in flight. */
  record(change: (value: T) => T): void {
    if (this.inFlight) this.pending.push(change);
  }
}

// Reads ------------------------------------------------------------------------------------------

/** A read whose rows didn't match the expected shape; shown as a generic error, never the details. */
export class InboxDataError extends Error {
  constructor(what: string) {
    super(`The ${what} data had an unexpected shape.`);
    this.name = "InboxDataError";
  }
}

/** The newest conversations of the member's business, each with its contact, open handoffs and latest message. */
export async function fetchConversations(client: SupabaseClient, tenantId: string): Promise<ConversationSummary[]> {
  const { data, error } = await client
    .from("conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("tenant_id", tenantId)
    .is("handoffs.resolved_at", null)
    .neq("messages.sender", "system")
    .order("created_at", { ascending: false, referencedTable: "messages" })
    .limit(1, { referencedTable: "messages" })
    .order("created_at", { ascending: false })
    .limit(CONVERSATION_LIMIT);
  if (error) throw error;
  const parsed = z.array(ConversationListRow).safeParse(data ?? []);
  if (!parsed.success) throw new InboxDataError("conversation");
  return sortConversations(parsed.data.filter((r) => r.tenant_id === tenantId).map(toConversationSummary));
}

/**
 * One conversation of the member's business by id, shaped like a list row, or null when there is none (an unknown id, or
 * another business's: never returned). The list only holds the newest CONVERSATION_LIMIT chats, so a link to an older chat
 * (a staff alert, a takeover link) reads it here instead of opening nothing.
 */
export async function fetchConversation(client: SupabaseClient, tenantId: string, conversationId: string): Promise<ConversationSummary | null> {
  const { data, error } = await client
    .from("conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("id", conversationId)
    .is("handoffs.resolved_at", null)
    .neq("messages.sender", "system")
    .order("created_at", { ascending: false, referencedTable: "messages" })
    .limit(1, { referencedTable: "messages" })
    .limit(1);
  if (error) throw error;
  const parsed = z.array(ConversationListRow).safeParse(data ?? []);
  if (!parsed.success) throw new InboxDataError("conversation");
  const row = parsed.data.find((r) => r.tenant_id === tenantId && r.id === conversationId);
  return row ? toConversationSummary(row) : null;
}

/** The newest MESSAGE_LIMIT messages of one conversation, oldest first. */
export async function fetchMessages(client: SupabaseClient, tenantId: string, conversationId: string): Promise<ChatMessage[]> {
  const { data, error } = await client
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(MESSAGE_LIMIT);
  if (error) throw error;
  const parsed = z.array(MessageRow).safeParse(data ?? []);
  if (!parsed.success) throw new InboxDataError("message");
  return parsed.data
    .filter((r) => r.tenant_id === tenantId && r.conversation_id === conversationId)
    .map(toChatMessage)
    .reduce<ChatMessage[]>((all, m) => upsertMessage(all, m), []);
}

// Time and the 24-hour window ---------------------------------------------------------------------

function dayKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(iso));
}

/** Calendar days between two instants in the business's time zone (0 = same day). */
export function daysAgo(iso: string, now: Date, timeZone: string): number {
  const toUtc = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(dayKey(now.toISOString(), timeZone)) - toUtc(dayKey(iso, timeZone))) / 86_400_000);
}

/** "9:42 am" */
export function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(new Date(iso));
}

/** List column: "9:42 am" today, "Yesterday", "Wed" this week, otherwise "7 Oct". */
export function formatListTime(iso: string, now: Date, timeZone: string): string {
  const days = daysAgo(iso, now, timeZone);
  if (days <= 0) return formatClock(iso, timeZone);
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone }).format(new Date(iso));
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone }).format(new Date(iso));
}

/** Day chip above a day's messages: "TODAY", "YESTERDAY", "WEDNESDAY", "7 OCT 2026". */
export function dayChipLabel(iso: string, now: Date, timeZone: string): string {
  const days = daysAgo(iso, now, timeZone);
  if (days <= 0) return "TODAY";
  if (days === 1) return "YESTERDAY";
  const opts: Intl.DateTimeFormatOptions =
    days < 7 ? { weekday: "long", timeZone } : { day: "numeric", month: "short", year: "numeric", timeZone };
  return new Intl.DateTimeFormat("en-IN", opts).format(new Date(iso)).toUpperCase();
}

/** "yesterday", "on Wednesday", "on 7 Oct" (for the window-closed strip). */
export function lastWrotePhrase(iso: string, now: Date, timeZone: string): string {
  const days = daysAgo(iso, now, timeZone);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `on ${new Intl.DateTimeFormat("en-IN", { weekday: "long", timeZone }).format(new Date(iso))}`;
  return `on ${new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone }).format(new Date(iso))}`;
}

/** WhatsApp allows free text for 24 hours after the customer's last message. */
export function isWindowOpen(lastCustomerMsgAt: string | null, now: Date): boolean {
  return lastCustomerMsgAt !== null && now.getTime() - Date.parse(lastCustomerMsgAt) < WINDOW_MS;
}

/** Messages grouped under day chips, in order. */
export function groupByDay(
  messages: ChatMessage[],
  now: Date,
  timeZone: string,
): { key: string; label: string; messages: ChatMessage[] }[] {
  const groups: { key: string; label: string; messages: ChatMessage[] }[] = [];
  for (const m of messages) {
    const key = dayKey(m.createdAt, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.messages.push(m);
    else groups.push({ key, label: dayChipLabel(m.createdAt, now, timeZone), messages: [m] });
  }
  return groups;
}

const TRIGGER_TEXT: Record<string, string> = {
  asked_human: "Asked for a person",
  complaint: "Upset / complaint",
  opt_out: "Opted out – don’t WhatsApp unless they write again",
  negotiation: "wants to negotiate the price",
  hot_lead: "a hot lead",
  kb_gap: "asked something the AI couldn't answer",
  stuck: "the chat got stuck",
  credits_exhausted: "out of credits, so the AI can't reply",
};

/** Why a chat was handed over, from handoffs.trigger (pack-specific triggers are shown as written). */
export function handoffReason(trigger: string | undefined): string {
  if (!trigger) return "handed to your team";
  return TRIGGER_TEXT[trigger] ?? trigger.replace(/_/g, " ");
}

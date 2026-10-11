import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { BOOKING_COLUMNS, bookingTitle, effectiveStatus, parseBookings, STATUS_LABEL, type Booking } from "@/features/calendar/bookings";
import { formatWhen } from "@/features/calendar/time";
import { describeMessage, maskPhoneForDisplay, Timestamp } from "@/features/inbox/data";

// Leads for the Day 3 board and lead detail (docs/dashboard-screen-contracts.md, Leads). The browser
// reads leads, contacts, conversations, messages, handoffs and bookings as the signed-in member: RLS
// (is_member) is the boundary and every query also filters by the session's tenant. The score, the
// temperature and the collected answers (leads.fields) are written by Dev 1's qualification engine and
// shown exactly as stored: nothing here scores a lead or decides hot, warm or cold.
//
// Answers are labelled from the business's pack (vertical_packs, by tenants.vertical and
// vertical_version). No question list is written in code: a pack field with no answer shows as
// unanswered, and an answer whose key the pack doesn't have is still shown, with its key as the label.

// Stages and temperature ---------------------------------------------------------------------------------

/** leads_stage_check (0001), in pipeline order. Pack labels for stages don't exist yet. */
export const STAGES = ["new", "engaged", "qualified", "booked", "visited", "won", "lost", "nurture", "human"] as const;
export type Stage = (typeof STAGES)[number];

const STAGE_LABEL: Record<Stage, string> = {
  new: "New",
  engaged: "Engaged",
  qualified: "Qualified",
  booked: "Booked",
  visited: "Visited",
  won: "Won",
  lost: "Lost",
  nurture: "Nurture",
  human: "With staff",
};

export function stageLabel(stage: string): string {
  return (STAGE_LABEL as Record<string, string>)[stage] ?? humanize(stage);
}

/** leads.temperature (0001). null = not scored yet. */
export const TEMPERATURES = ["hot", "warm", "cold", "disqualified"] as const;
export type Temperature = (typeof TEMPERATURES)[number];

export const TEMPERATURE_LABEL: Record<Temperature | "unscored", string> = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
  disqualified: "Disqualified",
  unscored: "Not scored",
};

/** The prototype's score badge colours (features/leads/pakka-leads.tsx), keyed by the stored temperature. */
export const TEMPERATURE_STYLE: Record<Temperature | "unscored", { bg: string; fg: string }> = {
  hot: { bg: "var(--color-accent-600)", fg: "#fff" },
  warm: { bg: "var(--color-accent-200)", fg: "var(--color-accent-800)" },
  cold: { bg: "var(--color-neutral-300)", fg: "var(--color-neutral-800)" },
  disqualified: { bg: "var(--color-neutral-700)", fg: "var(--color-bg)" },
  unscored: { bg: "transparent", fg: "var(--color-neutral-700)" },
};

// Rows -----------------------------------------------------------------------------------------------

const Contact = z.object({ name: z.string().nullable(), phone: z.string() }).nullable();

export const LeadRow = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  contact_id: z.guid(),
  stage: z.string(),
  score: z.number().nullable(),
  // A value added later than this screen is shown as not scored rather than failing the read.
  temperature: z.enum(TEMPERATURES).nullable().catch(null),
  fields: z.record(z.string(), z.unknown()).catch({}),
  owner_user_id: z.guid().nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
  contacts: Contact,
});
export type LeadRow = z.input<typeof LeadRow>;

export const LEAD_COLUMNS = "id, tenant_id, contact_id, stage, score, temperature, fields, owner_user_id, created_at, updated_at, contacts (name, phone)";

/**
 * Leads read per page, newest-updated first. The board loads one page and offers "Load more": nothing assumes every
 * lead fits in one answer. Large enough that a typical business never sees the button, small enough to stay quick.
 */
export const LEAD_PAGE_SIZE = 200;

export interface Lead {
  id: string;
  contactId: string;
  /** Contact name, or the masked number. */
  name: string;
  hasName: boolean;
  phoneMasked: string;
  stage: string;
  score: number | null;
  temperature: Temperature | null;
  answers: Record<string, unknown>;
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toLead(row: z.output<typeof LeadRow>): Lead {
  const phoneMasked = maskPhoneForDisplay(row.contacts?.phone ?? "");
  const name = row.contacts?.name?.trim() || null;
  return {
    id: row.id,
    contactId: row.contact_id,
    name: name ?? phoneMasked,
    hasName: name !== null,
    phoneMasked,
    stage: row.stage,
    score: row.score,
    temperature: row.temperature,
    answers: row.fields,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LeadDataError extends Error {
  constructor(what: string) {
    super(`The ${what} data had an unexpected shape.`);
    this.name = "LeadDataError";
  }
}

export function parseLeads(data: unknown, tenantId: string): Lead[] {
  const parsed = z.array(LeadRow).safeParse(data ?? []);
  if (!parsed.success) throw new LeadDataError("lead");
  return parsed.data.filter((r) => r.tenant_id === tenantId).map(toLead);
}

// Pack fields ------------------------------------------------------------------------------------------

/** What the screens need from a pack field (PackField in @pakka/types); read loosely, never trusted. */
export interface PackFieldInfo {
  key: string;
  label: string;
  type: string | null;
  required: boolean;
}

const PackFields = z.object({
  fields: z.array(
    z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      type: z.string().optional(),
      required: z.boolean().optional(),
    }),
  ),
});

/**
 * The business's pack field list, in pack order, or [] when there is none to read (no pack row for
 * the business's vertical and version, or one this screen can't read). Answers then show with their keys.
 */
export async function fetchPackFields(client: SupabaseClient, tenantId: string): Promise<PackFieldInfo[]> {
  const tenant = await client.from("tenants").select("id, vertical, vertical_version").eq("id", tenantId).maybeSingle();
  if (tenant.error) throw tenant.error;
  const t = z.object({ id: z.guid(), vertical: z.string(), vertical_version: z.number().int() }).safeParse(tenant.data);
  if (!t.success || t.data.id !== tenantId) return [];
  const pack = await client.from("vertical_packs").select("definition").eq("key", t.data.vertical).eq("version", t.data.vertical_version).maybeSingle();
  if (pack.error) throw pack.error;
  const parsed = PackFields.safeParse((pack.data as { definition?: unknown } | null)?.definition);
  if (!parsed.success) return [];
  return parsed.data.fields.map((f) => ({ key: f.key, label: f.label, type: f.type ?? null, required: f.required ?? false }));
}

// Answers ----------------------------------------------------------------------------------------------

/** "budget_max" → "Budget max". For keys the pack doesn't label. */
export function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** An answer as text, whatever shape the engine stored. */
export function formatAnswer(value: unknown, type: string | null = null): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return type === "range_inr" ? rupees(value) : value.toLocaleString("en-IN");
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((v) => formatAnswer(v, type)).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const lo = o.min ?? o.from;
    const hi = o.max ?? o.to;
    if (lo !== undefined || hi !== undefined) {
      const f = (v: unknown) => (isEmpty(v) ? "" : formatAnswer(v, type));
      if (!isEmpty(lo) && !isEmpty(hi)) return `${f(lo)} – ${f(hi)}`;
      return isEmpty(lo) ? `Up to ${f(hi)}` : `From ${f(lo)}`;
    }
    return Object.entries(o)
      .filter(([, v]) => !isEmpty(v))
      .map(([k, v]) => `${humanize(k)}: ${formatAnswer(v, null)}`)
      .join(", ");
  }
  return "";
}

export interface AnswerRow {
  key: string;
  label: string;
  /** null = not answered yet. */
  value: string | null;
  required: boolean;
  /** false: the engine stored it but the pack has no such field. */
  inPack: boolean;
}

/** Every pack field in pack order (answered or not), then any other stored answer. */
export function answerRows(answers: Record<string, unknown>, packFields: PackFieldInfo[]): AnswerRow[] {
  const known = new Set(packFields.map((f) => f.key));
  const rows: AnswerRow[] = packFields.map((f) => {
    const v = answers[f.key];
    const text = isEmpty(v) ? "" : formatAnswer(v, f.type);
    return { key: f.key, label: f.label, value: text ? text : null, required: f.required, inPack: true };
  });
  for (const [key, v] of Object.entries(answers)) {
    if (known.has(key) || isEmpty(v)) continue;
    const text = formatAnswer(v);
    if (text) rows.push({ key, label: humanize(key), value: text, required: false, inPack: false });
  }
  return rows;
}

/** The first answered fields, for a board card: "Budget: ₹80,00,000 · Area: Velachery". */
export function qualificationSummary(answers: Record<string, unknown>, packFields: PackFieldInfo[], max = 2): string | null {
  const answered = answerRows(answers, packFields).filter((r) => r.value !== null);
  if (answered.length === 0) return null;
  return answered
    .slice(0, max)
    .map((r) => `${r.label}: ${r.value}`)
    .join(" · ");
}

// The board ----------------------------------------------------------------------------------------------

export type TemperatureFilter = "all" | Temperature | "unscored";

export interface LeadFilters {
  temperature: TemperatureFilter;
  /** Only leads scored at least this; null = any score (and unscored leads). */
  minScore: number | null;
}

export function matchesFilters(lead: Lead, f: LeadFilters): boolean {
  if (f.temperature === "unscored" && lead.temperature !== null) return false;
  if (f.temperature !== "all" && f.temperature !== "unscored" && lead.temperature !== f.temperature) return false;
  if (f.minScore !== null && (lead.score === null || lead.score < f.minScore)) return false;
  return true;
}

/** "70" → 70; blank → null; anything else → undefined (invalid). */
export function parseMinScore(raw: string): number | null | undefined {
  const s = raw.trim();
  if (s === "") return null;
  if (!/^\d{1,4}$/.test(s)) return undefined;
  return Number(s);
}

export interface StageColumn {
  stage: string;
  label: string;
  leads: Lead[];
}

/** One column per stage in pipeline order, plus any stage the engine stores that this list lacks. */
export function groupByStage(leads: Lead[]): StageColumn[] {
  const extra = [...new Set(leads.map((l) => l.stage).filter((s) => !(STAGES as readonly string[]).includes(s)))].sort();
  return [...STAGES, ...extra].map((stage) => ({
    stage,
    label: stageLabel(stage),
    leads: leads.filter((l) => l.stage === stage).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.updatedAt.localeCompare(a.updatedAt)),
  }));
}

/** Counts for the filter chips. */
export function temperatureCounts(leads: Lead[]): Record<TemperatureFilter, number> {
  const counts: Record<TemperatureFilter, number> = { all: leads.length, hot: 0, warm: 0, cold: 0, disqualified: 0, unscored: 0 };
  for (const l of leads) counts[l.temperature ?? "unscored"]++;
  return counts;
}

/** "just now", "12 min ago", "3 h ago", "Yesterday", "7 Oct". */
export function formatAgo(iso: string, now: Date, timeZone: string): string {
  const ms = now.getTime() - Date.parse(iso);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 24 * 3_600_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  if (ms < 48 * 3_600_000) return "Yesterday";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone }).format(new Date(iso));
}

// Reads ------------------------------------------------------------------------------------------------

/**
 * Where the next page starts: the last lead of the previous page, by the two columns the page is ordered by. These are
 * the stored strings exactly as the database sent them (a Date would drop the microseconds and could skip or repeat a
 * lead that was updated in the same millisecond). Leads that change or arrive while someone is paging move to the
 * front, so a page boundary by position (an offset) would repeat or skip rows; a boundary by value does neither.
 */
export interface LeadCursor {
  updatedAt: string;
  id: string;
}

export interface LeadsPage {
  leads: Lead[];
  /** The cursor for the next page, or null when this was the last (it held fewer rows than asked for). */
  next: LeadCursor | null;
}

const CursorRow = z.object({ updated_at: z.string().min(1), id: z.guid() });

/**
 * One page of the business's leads, newest-updated first (then by id, so the order never ties). Plain PostgREST
 * reads under RLS, like every other screen: no new endpoint. Rows of another business are dropped even if they arrive.
 */
export async function fetchLeadsPage(client: SupabaseClient, tenantId: string, cursor: LeadCursor | null = null, pageSize = LEAD_PAGE_SIZE): Promise<LeadsPage> {
  let query = client.from("leads").select(LEAD_COLUMNS).eq("tenant_id", tenantId);
  if (cursor) {
    // Strictly older than the last lead shown: an older update, or the same moment with a smaller id.
    query = query.or(`updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`);
  }
  const { data, error } = await query.order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(pageSize);
  if (error) throw error;
  const rows: unknown[] = Array.isArray(data) ? data : [];
  const leads = parseLeads(rows, tenantId);
  if (rows.length < pageSize) return { leads, next: null };
  // A full page: there may be more. The cursor comes from the last row as sent; without a usable one, say so instead of guessing.
  const last = CursorRow.safeParse(rows[rows.length - 1]);
  if (!last.success) throw new LeadDataError("lead");
  return { leads, next: { updatedAt: last.data.updated_at, id: last.data.id } };
}

/** One lead, or null when it isn't the business's (RLS shows nothing) or doesn't exist. */
export async function fetchLead(client: SupabaseClient, tenantId: string, leadId: string): Promise<Lead | null> {
  const { data, error } = await client.from("leads").select(LEAD_COLUMNS).eq("tenant_id", tenantId).eq("id", leadId).limit(1);
  if (error) throw error;
  return parseLeads(data, tenantId).find((l) => l.id === leadId) ?? null;
}

// Timeline -------------------------------------------------------------------------------------------

/** Newest messages taken into the timeline; the chat in the Inbox has the rest. */
export const TIMELINE_MESSAGE_LIMIT = 200;

const ConversationRow = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  contact_id: z.guid(),
  mode: z.string(),
  created_at: Timestamp,
  handoffs: z.array(
    z.object({ id: z.guid(), trigger: z.string(), picked_at: Timestamp.nullable(), resolved_at: Timestamp.nullable() }),
  ),
});

const TimelineMessageRow = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  conversation_id: z.guid(),
  sender: z.enum(["customer", "ai", "staff", "system"]),
  kind: z.string().nullable().optional(),
  body: z.string().nullable(),
  media: z.unknown().optional(),
  meta: z.unknown().optional(),
  template_name: z.string().nullable(),
  created_at: Timestamp,
});

export type TimelineKind = "lead" | "customer" | "ai" | "staff" | "system" | "handoff" | "booking";

export interface TimelineEntry {
  id: string;
  at: string;
  kind: TimelineKind;
  label: string;
  text: string;
  /** Orders entries recorded at the same moment (bookings: by when they are). */
  then?: string;
}

export interface LeadActivity {
  timeline: TimelineEntry[];
  /** The newest conversation, for "Open chat". */
  latestConversationId: string | null;
  /** Open handovers (no time is stored for when they opened). */
  openHandoffs: { trigger: string }[];
  bookings: Booking[];
  /** More messages exist than the timeline shows. */
  messagesTruncated: boolean;
}

const SENDER_LABEL: Record<"customer" | "ai" | "staff" | "system", string> = { customer: "Customer", ai: "AI", staff: "Staff", system: "Update" };

/** A booking as a timeline line: what, when, and what it is now. */
export function bookingEntry(b: Booking, now: Date, timeZone: string): TimelineEntry {
  const status = effectiveStatus(b, now);
  const when = formatWhen(b.start, timeZone);
  const what = bookingTitle(b);
  const label = b.rescheduledFrom ? "Booking moved" : "Booking";
  const text = b.rescheduledFrom ? `${what}, moved to ${when} · ${STATUS_LABEL[status]}` : `${what} for ${when} · ${STATUS_LABEL[status]}`;
  const reason = status === "cancelled" && b.cancelReason ? (b.cancelReason === "replaced" ? " (the customer picked another time)" : ` (${b.cancelReason})`) : "";
  return { id: `booking-${b.id}`, at: b.createdAt, kind: "booking", label, text: text + reason, then: b.start };
}

/** Builds the lead's timeline, oldest first, from what the database already holds. */
export function buildTimeline(opts: {
  lead: Lead;
  conversations: z.output<typeof ConversationRow>[];
  messages: z.output<typeof TimelineMessageRow>[];
  bookings: Booking[];
  now: Date;
  timeZone: string;
}): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ id: `lead-${opts.lead.id}`, at: opts.lead.createdAt, kind: "lead", label: "Lead", text: "Became a lead." }];
  for (const m of opts.messages) {
    const d = describeMessage({ kind: m.kind ?? null, body: m.body, media: m.media, meta: m.meta, templateName: m.template_name });
    const text = d.preview.length > 280 ? `${d.preview.slice(0, 279)}…` : d.preview;
    entries.push({ id: `message-${m.id}`, at: m.created_at, kind: m.sender, label: SENDER_LABEL[m.sender], text: text || "(no text)" });
  }
  for (const c of opts.conversations) {
    for (const h of c.handoffs) {
      const why = humanize(h.trigger).toLowerCase();
      if (h.picked_at) entries.push({ id: `handoff-picked-${h.id}`, at: h.picked_at, kind: "handoff", label: "Handover", text: `Staff took over the chat (${why}).` });
      if (h.resolved_at) entries.push({ id: `handoff-resolved-${h.id}`, at: h.resolved_at, kind: "handoff", label: "Handover", text: `Handover closed (${why}).` });
    }
  }
  for (const b of opts.bookings) entries.push(bookingEntry(b, opts.now, opts.timeZone));
  return entries.sort((a, b) => a.at.localeCompare(b.at) || (a.then ?? "").localeCompare(b.then ?? "") || a.id.localeCompare(b.id));
}

export async function fetchLeadActivity(client: SupabaseClient, tenantId: string, lead: Lead, now: Date, timeZone: string): Promise<LeadActivity> {
  const [convResult, bookingResult] = await Promise.all([
    client
      .from("conversations")
      .select("id, tenant_id, contact_id, mode, created_at, handoffs (id, trigger, picked_at, resolved_at)")
      .eq("tenant_id", tenantId)
      .eq("contact_id", lead.contactId)
      .order("created_at", { ascending: false }),
    client.from("bookings").select(BOOKING_COLUMNS).eq("tenant_id", tenantId).eq("lead_id", lead.id).order("start_at", { ascending: true }),
  ]);
  if (convResult.error) throw convResult.error;
  if (bookingResult.error) throw bookingResult.error;
  const convs = z.array(ConversationRow).safeParse(convResult.data ?? []);
  if (!convs.success) throw new LeadDataError("conversation");
  const conversations = convs.data.filter((c) => c.tenant_id === tenantId && c.contact_id === lead.contactId);
  const bookings = parseBookings(bookingResult.data, tenantId).filter((b) => b.leadId === lead.id);

  let messages: z.output<typeof TimelineMessageRow>[] = [];
  if (conversations.length > 0) {
    const ids = conversations.map((c) => c.id);
    const result = await client
      .from("messages")
      .select("id, tenant_id, conversation_id, sender, kind, body, media, meta, template_name, created_at")
      .eq("tenant_id", tenantId)
      .in("conversation_id", ids)
      .order("created_at", { ascending: false })
      .limit(TIMELINE_MESSAGE_LIMIT);
    if (result.error) throw result.error;
    const parsed = z.array(TimelineMessageRow).safeParse(result.data ?? []);
    if (!parsed.success) throw new LeadDataError("message");
    messages = parsed.data.filter((m) => m.tenant_id === tenantId && ids.includes(m.conversation_id));
  }

  return {
    timeline: buildTimeline({ lead, conversations, messages, bookings, now, timeZone }),
    latestConversationId: conversations[0]?.id ?? null,
    openHandoffs: conversations.flatMap((c) => c.handoffs.filter((h) => h.resolved_at === null).map((h) => ({ trigger: h.trigger }))),
    bookings,
    messagesTruncated: messages.length >= TIMELINE_MESSAGE_LIMIT,
  };
}

// A tiny stand-in for Supabase Auth (GoTrue) and PostgREST, for Playwright only. It speaks the same
// HTTP protocol as the real services, so the app's real @supabase/ssr code runs unchanged; only
// NEXT_PUBLIC_SUPABASE_URL points here. No dependencies; run with `node`.
//
// Accounts (password for all: e2e-password-1) cover each state the app must handle.
//
// Signup, email confirmation and "Continue with Google" follow GoTrue's PKCE flow:
//   * POST /auth/v1/signup creates an account with no business. Addresses @confirm.test.local need
//     email confirmation: the link is "sent" to /__mock/last-email?to=… and opening it redirects to
//     the app's /auth/callback with a one-time code. Other addresses get a session straight away.
//   * GET /auth/v1/authorize?provider=google shows a stand-in Google account chooser; picking an
//     account (or Cancel) redirects to the app's /auth/callback like Supabase does.
//   * POST /auth/v1/token?grant_type=pkce checks the code verifier against the stored challenge.
//   * POST /auth/v1/recover "sends" a password reset link (only for existing accounts, but answers the
//     same either way); opening it signs the account in through /auth/callback, and PUT /auth/v1/user
//     sets the new password.
// GET /__mock/rest-log?email=… lists the PostgREST requests made with that user's token, so tests can
// check that nothing was written and no tenant-scoped table was read.
// POST /rest/v1/rpc/create_trial_tenant (service role only) gives a user a trial business, membership,
// credits and route code the way the SQL function does; GET /__mock/business?email=… reads them back.
// POST /__mock/onboarding-account makes an account with no business and its own pack catalogue (or a
// failing one), for the trades onboarding offers.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_SUPABASE_PORT ?? 54399);
export const PASSWORD = "e2e-password-1";

const tenant = (id, name, vertical) => ({
  id, name, vertical, timezone: "Asia/Kolkata", status: "trial", plan_key: "trial", trial_ends_at: "2026-10-12T00:00:00Z",
});
const T = {
  realty: tenant("10000000-0000-0000-0000-000000000001", "Test Realty", "real-estate"),
  salon: tenant("10000000-0000-0000-0000-000000000002", "Beta Salon", "salon"),
  interiors: tenant("10000000-0000-0000-0000-000000000003", "Bright Interiors", "interiors"),
  inbox: tenant("10000000-0000-0000-0000-000000000004", "Inbox Realty", "real-estate"),
};
const connection = (tenantId, status) => ({
  id: "30000000-0000-0000-0000-000000000001", tenant_id: tenantId, method: "embedded_signup", waba_id: "102938475610",
  phone_number_id: "109876543210987", display_phone: "+91 98400 12345", verified_name: "Bright Interiors", coexistence: true,
  status, last_check: {}, quality_rating: "GREEN", messaging_limit: "TIER_1K", created_at: "2026-10-01T09:00:00Z",
});
const MISSING_VIEW = { status: 404, body: { code: "PGRST205", details: null, hint: null, message: "Could not find the table 'public.whatsapp_connections_public' in the schema cache" } };

// view: what whatsapp_connections_public returns for this user ({ status, body, delay }).
const USERS = {
  "owner@test.local": { memberships: [[T.realty, "owner"]], view: MISSING_VIEW },
  "staff@test.local": { memberships: [[T.realty, "staff"]], view: { status: 200, body: [] } },
  "connected@test.local": { memberships: [[T.interiors, "owner"]], view: { status: 200, body: [connection(T.interiors.id, "active")] } },
  "disconnected@test.local": { memberships: [[T.interiors, "owner"]], view: { status: 200, body: [connection(T.interiors.id, "disconnected")] } },
  "viewerror@test.local": { memberships: [[T.realty, "owner"]], view: { status: 500, body: { code: "XX000", details: "internal detail", hint: null, message: "boom" } } },
  "slow@test.local": { memberships: [[T.realty, "owner"]], view: { status: 200, body: [], delay: 2500 } },
  "nomember@test.local": { memberships: [], view: { status: 200, body: [] } },
  "multi@test.local": { memberships: [[T.realty, "owner"], [T.salon, "admin"]], view: MISSING_VIEW },
  "pending@test.local": { memberships: [[T.interiors, "owner"]], view: { status: 200, body: [connection(T.interiors.id, "pending")] } },
  "failed@test.local": { memberships: [[T.interiors, "owner"]], view: { status: 200, body: [connection(T.interiors.id, "failed")] } },
  // Inbox: inbox@ has chats (INBOX below); owner@ has none; inboxerror@'s conversation reads return bad rows.
  "inbox@test.local": { memberships: [[T.inbox, "owner"]], view: { status: 200, body: [] } },
  "inboxerror@test.local": { memberships: [[T.realty, "owner"]], view: { status: 200, body: [] }, inboxError: true },
  "validating@test.local": { memberships: [[T.interiors, "owner"]], view: { status: 200, body: [connection(T.interiors.id, "validating")] } },
  // Same active number, seen by an admin and by staff: what each may do differs, the data doesn't.
  "wa-admin@test.local": { memberships: [[T.interiors, "admin"]], view: { status: 200, body: [connection(T.interiors.id, "active")] } },
  "wa-staff@test.local": { memberships: [[T.interiors, "staff"]], view: { status: 200, body: [connection(T.interiors.id, "active")] } },
  // Our own number (method platform, migration 0014), seeded with --skip-check so it has no number or
  // name yet, next to a client's own number on the same business.
  "wa-platform@test.local": {
    memberships: [[T.interiors, "owner"]],
    view: {
      status: 200,
      body: [
        { ...connection(T.interiors.id, "active"), id: "30000000-0000-0000-0000-000000000002", method: "platform", waba_id: "500000000000001",
          phone_number_id: "600000000000001", display_phone: null, verified_name: null, coexistence: false, quality_rating: null, messaging_limit: null },
        { ...connection(T.interiors.id, "active"), method: "manual_byo", coexistence: false },
      ],
    },
  },
};

// Inbox rows for T.inbox (conversations, contacts, handoffs, messages), with times relative to when the
// mock started so the 24-hour window is open or closed as described. Read-only: every project reads
// the same data in parallel.
const STARTED = Date.now();
const ago = (minutes) => new Date(STARTED - minutes * 60_000).toISOString();
const cid = (n) => `40000000-0000-0000-0000-00000000000${n}`;
const mid = (n) => `41000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
/** conversations.contact_id (not null): this business's contacts have no leads, so their lead card is empty. */
const inboxContact = (n) => `43000000-0000-0000-0000-00000000000${n}`;
const INBOX = {
  conversations: [
    // Needs human: open handoff, window open.
    { id: cid(1), tenant_id: T.inbox.id, mode: "ai", status: "open", last_customer_msg_at: ago(20), created_at: ago(30),
      contact_id: inboxContact(1), contacts: { name: "Karthik R", phone: "+919812345621", language: "ta" },
      handoffs: [{ id: "42000000-0000-0000-0000-000000000001", trigger: "asked_human", resolved_at: null }] },
    // AI handling, window open.
    { id: cid(2), tenant_id: T.inbox.id, mode: "ai", status: "open", last_customer_msg_at: ago(121), created_at: ago(125),
      contact_id: inboxContact(2), contacts: { name: "Priya S", phone: "+919900000037", language: "en" }, handoffs: [] },
    // A team member replying, window closed (customer wrote 3 days ago); its handoff is resolved.
    { id: cid(3), tenant_id: T.inbox.id, mode: "human", status: "open", last_customer_msg_at: ago(3 * 24 * 60), created_at: ago(3 * 24 * 60 + 10),
      contact_id: inboxContact(3), contacts: { name: "Lakshmi V", phone: "+919400000008", language: "ta" },
      handoffs: [{ id: "42000000-0000-0000-0000-000000000003", trigger: "complaint", resolved_at: ago(3 * 24 * 60) }] },
    // Own-number takeover, no name, no messages yet.
    { id: cid(4), tenant_id: T.inbox.id, mode: "external", status: "open", last_customer_msg_at: null, created_at: ago(4 * 24 * 60),
      contact_id: inboxContact(4), contacts: { name: null, phone: "+919000000052", language: null }, handoffs: [] },
  ],
  messages: [
    [1, cid(1), "in", "customer", "Velachery la 3BHK irukka? Ready to move venum", ago(25)],
    [2, cid(1), "out", "ai", "Vanakkam Karthik! Yes, ready-to-move 3BHKs are available. What budget are you looking at?", ago(24)],
    [3, cid(1), "out", "system", "Handed to team · asked for a person", ago(21)],
    [4, cid(1), "in", "customer", "Can I talk to someone about the price?", ago(20)],
    [5, cid(2), "in", "customer", "Hi, OMR 2BHK price enna?", ago(121)],
    // Inbound kinds as the webhook stores them (migration 0013; docs/task-notes/2026-10-08-feat-agent-webhook-post.md).
    [9, cid(2), "in", "customer", "This one, near the lake?", ago(120.9), "image", { id: "media-9", mime: "image/jpeg" }],
    [10, cid(2), "in", "customer", null, ago(120.8), "image", { id: "media-10", mime: "image/webp" }],
    [11, cid(2), "in", "customer", "My salary slip", ago(120.7), "document", { id: "media-11", mime: "application/pdf" }],
    [12, cid(2), "in", "customer", null, ago(120.6), "audio", { id: "media-12", mime: "audio/ogg; codecs=opus" }],
    [13, cid(2), "in", "customer", "12.9791,80.2209 Phoenix Marketcity Velachery Main Road, Chennai", ago(120.5), "location"],
    [14, cid(2), "in", "customer", null, ago(120.4), "unsupported", null, { unsupportedType: "sticker" }],
    [15, cid(2), "in", "customer", "Book a site visit", ago(120.3), "interactive", null, { buttonId: "book_visit" }],
    [6, cid(2), "out", "ai", "Hi Priya! 2BHKs on OMR start from ₹62 L.", ago(120)],
    [7, cid(3), "in", "customer", "Visit ku varen, parking iruka?", ago(3 * 24 * 60)],
    [8, cid(3), "out", "staff", "Yes ma’am, visitor parking is at the site office.", ago(3 * 24 * 60 - 5)],
  ].map(([n, conversation_id, direction, sender, body, created_at, kind = null, media = null, meta = kind ? {} : null]) => ({
    id: mid(n), tenant_id: T.inbox.id, conversation_id, direction, sender, kind, body, media, meta, template_name: null,
    delivery_status: null, created_at,
  })),
};
// Knowledge base services (0001 services, 0002 member writes, 0015 buffer_min and min_notice_min). Each
// Knowledge test creates its own account and business through POST /__mock/services-account, so the
// parallel projects never edit each other's rows. Rows: { id, tenant_id, name, duration_min, price_min,
// price_max, resource_type, active, buffer_min, min_notice_min }.
const SERVICES = [];
/** resources rows (0001, member writes in 0002): { id, tenant_id, type, name, working_hours, service_area, active }. */
const RESOURCES = [];
const SEED_SERVICES = [
  ["Haircut", 30, 300, 600, "stylist", true],
  ["Bridal trial", 90, 2500, 5000, "stylist", true],
  ["Hair spa", 60, null, null, "chair", false],
];
const resourceRow = (tenant_id, { name, type, working_hours = {}, service_area = null, active = true, id = randomUUID() }) =>
  ({ id, tenant_id, type, name, working_hours, service_area, active });
/**
 * kb_documents rows (0001, status/body from 0011), read-only for members:
 * { id, tenant_id, source_type, source_url, title, body, status, created_at }. FAQs are the manual rows
 * (title = question, body = answer). Tests change rows through /__mock/kb-documents, standing in for
 * the API and the ingest job, which write with the service role.
 */
const KB_DOCUMENTS = [];
const SEED_DOCUMENTS = [
  ["upload", null, "Bridal price list.pdf", "2026-10-01T05:30:00Z", "ready"],
  ["website", "https://glowstudio.in/services", null, "2026-10-05T05:30:00Z", "ready"],
];
const SEED_FAQS = [
  ["Do you do home visits?", "Yes, within 5 km of the studio, for bookings over ₹2,000.", "2026-09-20T05:30:00Z"],
  ["Is there parking?", "Yes, two-wheeler parking at the back of the building.", "2026-09-21T05:30:00Z"],
];
const kbDocument = (tenant_id, { source_type, source_url = null, title = null, body = null, status = "processing", error = null, created_at = new Date().toISOString() }) =>
  ({ id: randomUUID(), tenant_id, source_type, source_url, title, body, status, error, created_at });
/**
 * { seed?, error?, docs?, docsError?, faqs?, role? }: seed adds services and resource types; docs adds
 * kb_documents; faqs adds two FAQs; role is the member's role (owner by default). error / docsError
 * make that table's reads return rows the app can't parse.
 */
function createServicesAccount({ seed = false, error = false, docs = false, docsError = false, faqs = false, role = "owner" } = {}) {
  const email = `kb-${randomUUID()}@test.local`;
  const t = tenant(randomUUID(), "Glow Studio", "salon");
  USERS[email] = { memberships: [[t, role]], view: { status: 200, body: [] }, servicesError: error, kbDocumentsError: docsError };
  if (seed) {
    for (const [name, duration_min, price_min, price_max, resource_type, active] of SEED_SERVICES) {
      SERVICES.push({ id: randomUUID(), tenant_id: t.id, name, duration_min, price_min, price_max, resource_type, active, buffer_min: 0, min_notice_min: 60 });
    }
    RESOURCES.push(resourceRow(t.id, { name: "Chair 1", type: "chair" }), resourceRow(t.id, { name: "Stylist A", type: "stylist" }));
  }
  if (docs) {
    for (const [source_type, source_url, title, created_at, status] of SEED_DOCUMENTS) {
      KB_DOCUMENTS.push(kbDocument(t.id, { source_type, source_url, title, created_at, status }));
    }
  }
  if (faqs) {
    for (const [title, body, created_at] of SEED_FAQS) {
      KB_DOCUMENTS.push(kbDocument(t.id, { source_type: "manual", title, body, created_at, status: "ready" }));
    }
  }
  return { email, tenantId: t.id };
}
const SERVICE_COLUMNS = ["id", "tenant_id", "name", "duration_min", "price_min", "price_max", "resource_type", "active", "buffer_min", "min_notice_min"];
const pickService = (s) => Object.fromEntries(SERVICE_COLUMNS.map((k) => [k, s[k]]));

// Team (0001 memberships, 0002 own_preferences): the member's own alert number and takeover preference,
// keyed "email|tenant id". Every other seeded account starts with neither. Each Team test makes its own
// account through POST /__mock/team-account.
const MEMBER_PREFS = new Map();
const MEMBER_WRITABLE = ["whatsapp_phone", "takeover_pref"];
const prefsOf = (email, tenantId) => MEMBER_PREFS.get(`${email}|${tenantId}`) ?? { whatsapp_phone: null, takeover_pref: null };
/**
 * { role?, phone?, refused?, readError? } → { email, tenantId, userId }. phone is the stored alert number;
 * refused makes updates come back empty, as RLS does for a row that isn't the member's; readError makes
 * the Team screen's read return rows the app can't parse.
 */
function createTeamAccount({ role = "owner", phone = null, refused = false, readError = false } = {}) {
  const email = `team-${randomUUID()}@test.local`;
  const t = tenant(randomUUID(), "Team Studio", "salon");
  USERS[email] = { memberships: [[t, role]], view: { status: 200, body: [] }, prefsRefused: refused, prefsError: readError };
  if (phone) MEMBER_PREFS.set(`${email}|${t.id}`, { whatsapp_phone: phone, takeover_pref: null });
  return { email, tenantId: t.id, userId: idOf(email) };
}

// Day 3 (leads, calendar, booking setup). Each test makes its own business through
// POST /__mock/day3-account, so the desktop, tablet and phone projects never share rows. The business's
// pack key is made up ("sample-pack"): the screens must work for any pack. Times are fixed (the week of
// Monday 12 Oct 2026, Asia/Kolkata), so tests open the calendar on that date.
const CONTACTS = [];
/** leads rows (0001): { id, tenant_id, contact_id, stage, score, temperature, fields, owner_user_id, created_at, updated_at }. */
const LEADS = [];
/** bookings rows (0001, 0002, 0015). Members read them; only the booking engine writes. */
const BOOKINGS = [];
/**
 * vertical_packs rows: { key, version, active, definition }. The launch packs are the repo's own
 * packs/*.json, stored as the API's startup sync stores them (active, definition = the file), so that
 * sync finds them unchanged; they are what onboarding offers. sample-pack labels the Day 3 screens.
 */
const PACKS_DIR = new URL("../../../../packs/", import.meta.url);
const PACKS = [
  ...readdirSync(PACKS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(new URL(f, PACKS_DIR), "utf8")))
    .map((definition) => ({ key: definition.key, version: definition.version, active: true, definition })),
  {
    key: "sample-pack", version: 1, active: true,
    definition: {
      key: "sample-pack", version: 1,
      fields: [
        { key: "area", label: "Preferred area", type: "text", required: true },
        { key: "budget", label: "Budget", type: "range_inr", required: true },
        { key: "timeline", label: "When are you planning", type: "date_range_or_month", required: false },
      ],
    },
  },
];
/** tenant id → { business_hours, vertical_version } for businesses made during a run. */
const TENANT_EXTRA = new Map();
/** google_calendar_connections rows (0017). Members may read every column but the token. */
const CALENDARS = [];
const CALENDAR_READABLE = ["id", "tenant_id", "resource_id", "google_email", "calendar_id", "scope", "status", "last_error", "created_at", "updated_at"];
const ist = (date, hhmm) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();

/**
 * { seed?, role?, error?, inbox? } → { email, tenantId, ids }. seed adds the sample business below; error names
 * a table ("leads", "bookings", "resources", "tenants") whose reads return rows the app can't parse (switched
 * later with POST /__mock/day3-error); inbox (with seed) adds two more chats for the Inbox lead card.
 */
function createDay3Account({ seed = false, role = "owner", error = null, inbox = false, manyLeads = 0 } = {}) {
  const email = `d3-${randomUUID()}@test.local`;
  const t = tenant(randomUUID(), "Sample Business", "sample-pack");
  USERS[email] = { memberships: [[t, role]], view: { status: 200, body: [] }, day3Error: error };
  TENANT_EXTRA.set(t.id, { business_hours: {}, vertical_version: 1 });
  const ids = {};
  // `manyLeads`: that many plain leads, one per minute going back from 1 Sep 2026, each with its own contact and a
  // microsecond timestamp as PostgREST sends them (for the board's "Load more": paging by updated_at, then id).
  for (let i = 0; i < manyLeads; i++) {
    const contact = { id: randomUUID(), tenant_id: t.id, name: `Bulk lead ${i + 1}`, phone: `+9190000${String(10000 + i).slice(-5)}` };
    CONTACTS.push(contact);
    const at = `${new Date(Date.UTC(2026, 8, 1) - i * 60_000).toISOString().replace(/\.\d+Z$/, "")}.123456+00:00`;
    LEADS.push({
      id: randomUUID(), tenant_id: t.id, contact_id: contact.id, stage: ["new", "engaged", "qualified"][i % 3], score: null, temperature: null,
      fields: {}, owner_user_id: null, created_at: at, updated_at: at,
    });
  }
  if (!seed) return { email, tenantId: t.id, ids };

  const week = (start, end) => Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start, end }]]));
  TENANT_EXTRA.get(t.id).business_hours = { ...week("09:30", "19:00"), sun: [{ start: "10:00", end: "14:00" }] };
  const asha = resourceRow(t.id, { name: "Asha", type: "staff", working_hours: { ...week("10:00", "18:00"), sun: [] } });
  const ravi = resourceRow(t.id, { name: "Ravi", type: "staff", service_area: { pincodes: ["600041", "600096"] } });
  const room = resourceRow(t.id, { name: "Room 2", type: "room", active: false });
  RESOURCES.push(asha, ravi, room);
  Object.assign(ids, { asha: asha.id, ravi: ravi.id, room: room.id });
  // Ravi's calendar works; Room 2's token was refused by Google; Asha has none.
  const calendar = (resource, google_email, status) => ({
    id: randomUUID(), tenant_id: t.id, resource_id: resource.id, google_email, calendar_id: "primary", refresh_token_enc: "v1.never-sent-to-the-browser",
    scope: "calendar.events calendar.freebusy email", status, last_error: status === "connected" ? null : "invalid_grant", created_at: ist("2026-10-09", "10:00"), updated_at: ist("2026-10-09", "10:00"),
  });
  CALENDARS.push(calendar(ravi, "ravi@example.com", "connected"), calendar(room, "rooms@example.com", "needs_reconnect"));
  const consult = { id: randomUUID(), tenant_id: t.id, name: "Consultation", duration_min: 60, price_min: null, price_max: null, resource_type: "staff", active: true, buffer_min: 15, min_notice_min: 120 };
  const follow = { id: randomUUID(), tenant_id: t.id, name: "Follow-up", duration_min: 30, price_min: 0, price_max: 0, resource_type: "staff", active: true, buffer_min: 0, min_notice_min: 60 };
  SERVICES.push(consult, follow);
  ids.consult = consult.id;

  const person = (key, name, phone, stage, score, temperature, fields, updated) => {
    const contact = { id: randomUUID(), tenant_id: t.id, name, phone };
    CONTACTS.push(contact);
    const lead = { id: randomUUID(), tenant_id: t.id, contact_id: contact.id, stage, score, temperature, fields, owner_user_id: null, created_at: ist("2026-10-10", "10:00"), updated_at: updated };
    LEADS.push(lead);
    ids[key] = lead.id;
    return lead;
  };
  const karthik = person("karthik", "Karthik R", "+919812345621", "qualified", 82, "hot", { area: "Velachery", budget: { min: 6000000, max: 8000000 }, parking_needed: true }, ist("2026-10-11", "09:00"));
  const priya = person("priya", "Priya S", "+919900000037", "new", 55, "warm", { area: "OMR" }, ist("2026-10-11", "08:00"));
  const lakshmi = person("lakshmi", "Lakshmi V", "+919400000008", "booked", 30, "cold", {}, ist("2026-10-11", "07:00"));
  const unnamed = person("unnamed", null, "+919000000052", "engaged", null, null, {}, ist("2026-10-11", "06:00"));
  const deepa = person("deepa", "Deepa N", "+919700000063", "won", 90, "hot", { area: "Adyar" }, ist("2026-10-11", "05:00"));

  const booking = (key, lead, { resource = null, service = null, kind = "slot", status = "confirmed", date = "2026-10-12", start, end, hold = null, details = {} }) => {
    const b = {
      id: randomUUID(), tenant_id: t.id, lead_id: lead.id, resource_id: resource?.id ?? null, service_id: service?.id ?? null, kind, status,
      start_at: ist(date, start), end_at: ist(date, end), hold_expires_at: hold, details, created_at: ist("2026-10-11", "09:30"), calendar_event_id: null,
    };
    BOOKINGS.push(b);
    ids[key] = b.id;
  };
  booking("confirmed", karthik, { resource: asha, service: consult, start: "10:00", end: "11:00" });
  booking("held", priya, { resource: ravi, service: follow, status: "held", start: "11:30", end: "12:00", hold: "2099-01-01T00:00:00.000Z" });
  booking("lapsed", lakshmi, { resource: asha, service: consult, status: "held", start: "14:00", end: "15:00", hold: "2026-10-01T00:00:00.000Z" });
  booking("callback", unnamed, { kind: "callback", start: "16:00", end: "16:15" });
  booking("cancelled", deepa, { resource: ravi, service: consult, status: "cancelled", start: "12:00", end: "13:00", details: { cancel_reason: "replaced" } });
  booking("wednesday", karthik, { resource: ravi, service: consult, date: "2026-10-14", start: "15:00", end: "16:00" });
  booking("completed", lakshmi, { resource: asha, service: consult, status: "completed", date: "2026-10-13", start: "10:00", end: "11:00" });

  // Karthik's chat: customer, AI, customer, a system note, and a handover a teammate picked up.
  const conversationId = randomUUID();
  ids.karthikChat = conversationId;
  INBOX.conversations.push({
    id: conversationId, tenant_id: t.id, contact_id: karthik.contact_id, mode: "human", status: "open",
    last_customer_msg_at: ist("2026-10-11", "08:40"), created_at: ist("2026-10-11", "08:30"),
    contacts: { name: "Karthik R", phone: "+919812345621", language: "en" },
    handoffs: [{ id: randomUUID(), trigger: "asked_human", resolved_at: null, picked_at: ist("2026-10-11", "08:50") }],
  });
  const chat = [
    ["in", "customer", "Hi, is a 3BHK available in Velachery?", "08:30"],
    ["out", "ai", "Yes, there are a few. What budget are you looking at?", "08:31"],
    ["in", "customer", "60 to 80 L", "08:40"],
    ["out", "system", "Handed to team · asked for a person", "08:41"],
  ];
  for (const [direction, sender, body, at] of chat) {
    INBOX.messages.push({
      id: randomUUID(), tenant_id: t.id, conversation_id: conversationId, direction, sender, kind: sender === "customer" ? "text" : null,
      body, media: null, meta: null, template_name: null, delivery_status: null, created_at: ist("2026-10-11", at),
    });
  }
  if (inbox) {
    // The Inbox lead card: the unnamed customer's chat (an unscored lead with a callback), and a chat
    // from someone who isn't a lead (no leads row for the contact).
    const unnamedChat = randomUUID();
    INBOX.conversations.push({
      id: unnamedChat, tenant_id: t.id, contact_id: unnamed.contact_id, mode: "ai", status: "open",
      last_customer_msg_at: ist("2026-10-11", "07:10"), created_at: ist("2026-10-11", "07:00"),
      contacts: { name: null, phone: "+919000000052", language: null }, handoffs: [],
    });
    const meena = { id: randomUUID(), tenant_id: t.id, name: "Meena K", phone: "+919800000071" };
    CONTACTS.push(meena);
    const meenaChat = randomUUID();
    INBOX.conversations.push({
      id: meenaChat, tenant_id: t.id, contact_id: meena.id, mode: "ai", status: "open",
      last_customer_msg_at: ist("2026-10-11", "06:10"), created_at: ist("2026-10-11", "06:00"),
      contacts: { name: "Meena K", phone: "+919800000071", language: "ta" }, handoffs: [],
    });
    for (const [conversation_id, body, at] of [[unnamedChat, "Callback venum, evening", "07:10"], [meenaChat, "Hello, just looking", "06:10"]]) {
      INBOX.messages.push({
        id: randomUUID(), tenant_id: t.id, conversation_id, direction: "in", sender: "customer", kind: "text",
        body, media: null, meta: null, template_name: null, delivery_status: null, created_at: ist("2026-10-11", at),
      });
    }
    Object.assign(ids, { unnamedChat, meenaChat });
  }
  return { email, tenantId: t.id, ids };
}

const pick = (row, columns) => Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]]));
const contactOf = (contactId) => {
  const c = CONTACTS.find((x) => x.id === contactId);
  return c ? { name: c.name, phone: c.phone } : null;
};
/** A bookings row with the embeds the dashboard selects (services, resources, leads → contacts). */
const bookingWithEmbeds = (b) => ({
  ...b,
  services: b.service_id ? { name: SERVICES.find((s) => s.id === b.service_id)?.name ?? "" } : null,
  resources: b.resource_id ? { name: RESOURCES.find((r) => r.id === b.resource_id)?.name ?? "" } : null,
  leads: { contacts: contactOf(LEADS.find((l) => l.id === b.lead_id)?.contact_id) },
});
/** The PostgREST filters the mock understands (eq, in, lt, gt), applied after RLS. */
function filters(url) {
  const checks = [];
  for (const [column, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(column) || column.includes(".")) continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    if (op === "eq") checks.push((r) => String(r[column]) === value);
    else if (op === "in") {
      const set = new Set(value.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, "")));
      checks.push((r) => set.has(String(r[column])));
    } else if (op === "lt") checks.push((r) => Date.parse(r[column]) < Date.parse(value));
    else if (op === "gt") checks.push((r) => Date.parse(r[column]) > Date.parse(value));
  }
  return (r) => checks.every((check) => check(r));
}
/**
 * A vertical_packs row as PostgREST's `select` returns it: columns, `*`, and `alias:definition->>field`
 * (the JSON value as text, null when missing). null for a column the table doesn't have.
 */
function selectPack(row, select) {
  const out = {};
  for (const item of select.split(",").map((c) => c.trim()).filter(Boolean)) {
    if (item === "*") {
      Object.assign(out, row);
      continue;
    }
    const colon = item.indexOf(":");
    const alias = colon >= 0 ? item.slice(0, colon) : null;
    const expr = colon >= 0 ? item.slice(colon + 1) : item;
    const json = /^definition->>([a-z_]+)$/.exec(expr);
    if (json) {
      const value = row.definition[json[1]];
      out[alias ?? json[1]] = value == null ? null : typeof value === "string" ? value : JSON.stringify(value);
    } else if (expr in row) out[alias ?? expr] = row[expr];
    else return null;
  }
  return out;
}
/** The pack catalogue as this user's requests see it: the table, or the account's own stand-in. */
const packsFor = (email) => (email && USERS[email]?.packs) || PACKS;
/** Rows the app can't parse, for the error states (a 5xx would also log a console error, which the suite forbids). */
const day3Rows = (email, table, rows) => (USERS[email].day3Error === table ? [{ id: "not-a-row", internal: "boom" }] : rows);

/** A conversations row as the inbox's select returns it: open handoffs, newest non-system message. */
const inboxListRow = ({ handoffs, ...c }) => ({
  ...c,
  handoffs: handoffs.filter((h) => h.resolved_at === null).map(({ id, trigger }) => ({ id, trigger })),
  messages: INBOX.messages
    .filter((m) => m.conversation_id === c.id && m.sender !== "system")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 1)
    .map(({ id, sender, kind, body, media, meta, template_name, created_at }) => ({ id, sender, kind, body, media, meta, template_name, created_at })),
});
const idOf = (email) => `00000000-0000-0000-0000-${String(Object.keys(USERS).indexOf(email) + 1).padStart(12, "0")}`;
const userJson = (email) => ({ id: idOf(email), aud: "authenticated", role: "authenticated", email, app_metadata: { provider: USERS[email]?.provider ?? "email" }, user_metadata: {}, identities: [{ provider: USERS[email]?.provider ?? "email" }], created_at: "2026-10-01T00:00:00Z" });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const revoked = new Set();

// Accounts created during a run start without a business, like a real new signup.
const addUser = (email, password, provider = "email") => {
  USERS[email] ??= { memberships: [], view: { status: 200, body: [] }, password, provider };
};
// Seeded accounts share PASSWORD; Google-only accounts have none, so password sign-in fails for them.
const passwordOf = (email) => ("password" in USERS[email] ? USERS[email].password : PASSWORD);
const random = () => randomBytes(12).toString("base64url");

/** One-time auth codes waiting for a PKCE exchange: code → { email, challenge, method }. */
const authCodes = new Map();
/** Google sign-ins in progress on the chooser page: flow id → { redirectTo, challenge, method }. */
const oauthFlows = new Map();
/** Unconfirmed signups: token → { email, password, redirectTo, challenge, method }. */
const pendingSignups = new Map();
/** Password reset links not yet opened: token → { email, redirectTo, challenge, method }. */
const pendingRecoveries = new Map();
/** Last email "sent" to each address: { link }. */
const outbox = new Map();
/** Every PostgREST request: { email, method, table, query }; read back with /__mock/rest-log?email=. */
const restLog = [];

// Trial signup: create_trial_tenant and credit_balance (migrations 0005, 0006), callable only with the
// service-role key like the real grants. Read back with /__mock/business?email=.
const SERVICE_ROLE_KEY = process.env.MOCK_SERVICE_ROLE_KEY ?? "e2e-service-role-key";
/** plans.monthly_credits for 'trial' (supabase/seed/plans.sql). */
const TRIAL_CREDITS = 300;
/** tenant id → credit balance, and → TRIAL-xxxx code, for businesses created during a run. */
const balances = new Map();
const trialCodes = new Map();
/** email → number of create_trial_tenant calls made for that user. */
const trialCalls = new Map();
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Same checks and outcomes as public.create_trial_tenant; returns [status, body]. */
function createTrialTenant({ p_user_id, p_name, p_vertical, p_timezone }) {
  const fail = (message) => [400, { code: "P0001", details: null, hint: null, message }];
  const name = String(p_name ?? "").trim();
  if (!p_user_id) return fail("create_trial_tenant: user id is required");
  if (!name) return fail("create_trial_tenant: business name is required");
  if (!/^[a-z][a-z0-9-]*$/.test(String(p_vertical ?? ""))) {
    return fail("create_trial_tenant: vertical must be a pack key (lowercase letters, digits and hyphens)");
  }
  const email = Object.keys(USERS).find((e) => idOf(e) === p_user_id);
  if (!email) return fail(`create_trial_tenant: unknown user ${p_user_id}`);
  trialCalls.set(email, (trialCalls.get(email) ?? 0) + 1);
  // Until the pack loader has written vertical_packs, any well-formed key is accepted.
  const packs = packsFor(email);
  if (packs.length > 0 && !packs.some((p) => p.key === p_vertical && p.active)) {
    return fail(`create_trial_tenant: ${p_vertical} is not an active pack`);
  }

  const owned = USERS[email].memberships.find(([, role]) => role === "owner")?.[0];
  if (owned) {
    if (owned.status !== "trial") return fail("create_trial_tenant: this account already owns a business");
    return [200, [{ tenant_id: owned.id, route_code: trialCodes.get(owned.id) ?? null, trial_ends_at: owned.trial_ends_at, created: false }]];
  }
  const t = {
    ...tenant(randomUUID(), name, p_vertical),
    timezone: p_timezone ?? "Asia/Kolkata",
    trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const code = `TRIAL-${[...randomBytes(4)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
  USERS[email].memberships.push([t, "owner"]);
  balances.set(t.id, TRIAL_CREDITS);
  trialCodes.set(t.id, code);
  return [200, [{ tenant_id: t.id, route_code: code, trial_ends_at: t.trial_ends_at, created: true }]];
}

function issueCode(email, challenge, method) {
  const code = random();
  authCodes.set(code, { email, challenge, method });
  return code;
}
function withParams(target, params) {
  const url = new URL(target);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}
function redirect(res, to) {
  res.writeHead(303, { location: to }).end();
}
function verifierMatches(verifier, challenge, method) {
  if (!verifier || !challenge) return false;
  const expected = method === "plain" ? verifier : createHash("sha256").update(verifier).digest("base64url");
  return expected === challenge;
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Every token is new, like the real API's: two sign-ins in the same second must not share a token
// (logout revokes by token, which would otherwise sign the second one out too).
let issued = 0;
function session(email) {
  const now = Math.floor(Date.now() / 1000);
  const id = `${now}-${++issued}`;
  const access_token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: idOf(email), email, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, session_id: `s-${id}` })}.mock`;
  return { access_token, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: `refresh:${email}:${id}`, user: userJson(email) };
}
function emailFromToken(auth) {
  const token = (auth ?? "").replace(/^Bearer\s+/i, "");
  if (!token || revoked.has(token)) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return payload.exp > Date.now() / 1000 && USERS[payload.email] ? payload.email : null;
  } catch {
    return null;
  }
}

// The inbox reads Supabase from the browser (another origin), so answers carry CORS headers like the
// real API's.
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
const readBody = (req) => new Promise((resolve) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } }); });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  if (path === "/health") return send(res, 200, { ok: true });
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "*",
    });
    res.end();
    return;
  }

  if (path === "/auth/v1/token") {
    const body = await readBody(req);
    const grant = url.searchParams.get("grant_type");
    if (grant === "password") {
      if (USERS[body.email] && body.password === passwordOf(body.email)) return send(res, 200, session(body.email));
      return send(res, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
    }
    if (grant === "pkce") {
      const pending = authCodes.get(body.auth_code);
      authCodes.delete(body.auth_code); // single use, even when the verifier is wrong
      if (!pending) return send(res, 404, { code: 404, error_code: "flow_state_not_found", msg: "invalid flow state, no valid flow state found" });
      if (!verifierMatches(body.code_verifier, pending.challenge, pending.method)) {
        return send(res, 400, { code: 400, error_code: "bad_code_verifier", msg: "code challenge does not match previously saved code verifier" });
      }
      return send(res, 200, session(pending.email));
    }
    if (grant === "refresh_token") {
      const email = String(body.refresh_token ?? "").split(":")[1];
      if (USERS[email]) return send(res, 200, session(email));
      return send(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
    }
  }
  if (path === "/auth/v1/signup" && req.method === "POST") {
    const body = await readBody(req);
    const email = String(body.email ?? "").toLowerCase();
    const redirectTo = url.searchParams.get("redirect_to");
    const needsConfirmation = email.endsWith("@confirm.test.local");
    if (USERS[email]) {
      // Like GoTrue: with confirmation on, a taken address looks like a fresh signup (no identities);
      // with it off, the API says so and the app must not pass that on.
      if (needsConfirmation) return send(res, 200, { ...userJson(email), id: idOf(email), identities: [] });
      return send(res, 422, { code: 422, error_code: "user_already_exists", msg: "User already registered" });
    }
    if (String(body.password ?? "").length < 6) {
      return send(res, 422, { code: 422, error_code: "weak_password", msg: "Password should be at least 6 characters.", weak_password: { reasons: ["length"] } });
    }
    if (needsConfirmation) {
      const token = random();
      pendingSignups.set(token, { email, password: body.password, redirectTo, challenge: body.code_challenge, method: body.code_challenge_method });
      outbox.set(email, { link: `http://127.0.0.1:${PORT}/auth/v1/verify?token=${token}&type=signup&redirect_to=${encodeURIComponent(redirectTo ?? "")}` });
      return send(res, 200, { id: `pending-${token}`, aud: "authenticated", role: "", email, app_metadata: { provider: "email" }, user_metadata: {}, identities: [{ provider: "email" }], created_at: new Date().toISOString() });
    }
    addUser(email, body.password);
    return send(res, 200, session(email));
  }
  if (path === "/auth/v1/recover" && req.method === "POST") {
    const body = await readBody(req);
    const email = String(body.email ?? "").toLowerCase();
    const redirectTo = url.searchParams.get("redirect_to");
    if (USERS[email]) {
      const token = random();
      pendingRecoveries.set(token, { email, redirectTo, challenge: body.code_challenge, method: body.code_challenge_method });
      outbox.set(email, { link: `http://127.0.0.1:${PORT}/auth/v1/verify?token=${token}&type=recovery&redirect_to=${encodeURIComponent(redirectTo ?? "")}` });
    }
    return send(res, 200, {});
  }
  if (path === "/auth/v1/verify" && req.method === "GET" && url.searchParams.get("type") === "recovery") {
    const pending = pendingRecoveries.get(url.searchParams.get("token"));
    const redirectTo = url.searchParams.get("redirect_to");
    if (!pending) return redirect(res, withParams(redirectTo, { error: "access_denied", error_code: "otp_expired", error_description: "Email link is invalid or has expired" }));
    pendingRecoveries.delete(url.searchParams.get("token"));
    return redirect(res, withParams(pending.redirectTo, { code: issueCode(pending.email, pending.challenge, pending.method) }));
  }
  if (path === "/auth/v1/verify" && req.method === "GET") {
    const pending = pendingSignups.get(url.searchParams.get("token"));
    const redirectTo = url.searchParams.get("redirect_to");
    if (!pending) return redirect(res, withParams(redirectTo, { error: "access_denied", error_code: "otp_expired", error_description: "Email link is invalid or has expired" }));
    pendingSignups.delete(url.searchParams.get("token"));
    addUser(pending.email, pending.password);
    return redirect(res, withParams(pending.redirectTo, { code: issueCode(pending.email, pending.challenge, pending.method) }));
  }
  if (path === "/auth/v1/authorize" && url.searchParams.get("provider") === "google") {
    const flow = random();
    oauthFlows.set(flow, { redirectTo: url.searchParams.get("redirect_to"), challenge: url.searchParams.get("code_challenge"), method: url.searchParams.get("code_challenge_method") });
    const choose = (label, query) => `<li><a href="/__mock/google/consent?flow=${flow}&${query}">${escapeHtml(label)}</a></li>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Sign in with Google (mock)</title></head>
<body><h1>Choose an account</h1><ul>
${choose("owner@test.local", "account=owner%40test.local")}
${choose("Use a new Google account", "account=new")}
${choose("Cancel", "cancel=1")}
</ul></body></html>`);
    return;
  }
  if (path === "/__mock/google/consent") {
    const flow = oauthFlows.get(url.searchParams.get("flow"));
    oauthFlows.delete(url.searchParams.get("flow"));
    if (!flow) return send(res, 400, { msg: "unknown flow" });
    if (url.searchParams.get("cancel")) {
      return redirect(res, withParams(flow.redirectTo, { error: "access_denied", error_description: "The user denied the request" }));
    }
    const account = url.searchParams.get("account");
    const email = account === "new" ? `google-${random().toLowerCase()}@test.local` : account;
    addUser(email, undefined, "google");
    return redirect(res, withParams(flow.redirectTo, { code: issueCode(email, flow.challenge, flow.method) }));
  }
  if (path === "/__mock/rest-log") {
    const email = String(url.searchParams.get("email") ?? "").toLowerCase();
    return send(res, 200, restLog.filter((r) => r.email === email));
  }
  if (path === "/__mock/business") {
    // The user's businesses as the database would hold them, plus how often a trial was requested.
    const email = String(url.searchParams.get("email") ?? "").toLowerCase();
    const memberships = (USERS[email]?.memberships ?? []).map(([t, role]) => ({
      tenantId: t.id, name: t.name, vertical: t.vertical, status: t.status, planKey: t.plan_key, role,
      credits: balances.get(t.id) ?? null, routeCode: trialCodes.get(t.id) ?? null,
    }));
    return send(res, 200, { memberships, trialCalls: trialCalls.get(email) ?? 0 });
  }
  if (path === "/__mock/team-account" && req.method === "POST") {
    return send(res, 200, createTeamAccount(await readBody(req)));
  }
  if (path === "/__mock/memberships") {
    // A user's membership rows as stored, for checking writes: ?email=<email>.
    const email = String(url.searchParams.get("email") ?? "").toLowerCase();
    const rows = (USERS[email]?.memberships ?? []).map(([t, role]) => ({ tenant_id: t.id, user_id: idOf(email), role, ...prefsOf(email, t.id) }));
    return send(res, 200, rows);
  }
  if (path === "/__mock/day3-error" && req.method === "POST") {
    // { email, table } → that account's reads of `table` return bad rows from now on; table null clears it.
    const { email, table = null } = await readBody(req);
    if (!USERS[email]) return send(res, 404, { msg: "no such user" });
    USERS[email].day3Error = table;
    return send(res, 200, { ok: true });
  }
  if (path === "/__mock/day3-account" && req.method === "POST") {
    return send(res, 200, createDay3Account(await readBody(req)));
  }
  if (path === "/__mock/day3") {
    // A business's rows as stored, for checking writes: ?tenant=<id>.
    const tenantId = url.searchParams.get("tenant");
    const of = (rows) => rows.filter((r) => r.tenant_id === tenantId);
    return send(res, 200, { tenant: TENANT_EXTRA.get(tenantId) ?? null, resources: of(RESOURCES), services: of(SERVICES), bookings: of(BOOKINGS), leads: of(LEADS) });
  }
  if (path === "/__mock/onboarding-account" && req.method === "POST") {
    // { packs?: vertical_packs rows, packsError?: boolean } → { email }: an account with no business
    // whose pack catalogue is `packs` instead of the table, or whose reads of it fail (password PASSWORD).
    const { packs, packsError = false } = await readBody(req);
    const email = `ob-${randomUUID()}@test.local`;
    USERS[email] = { memberships: [], view: { status: 200, body: [] }, ...(packs ? { packs } : {}), packsError };
    return send(res, 200, { email });
  }
  if (path === "/__mock/services-account" && req.method === "POST") {
    // { seed?: boolean, error?: boolean } → { email, tenantId }; the password is PASSWORD.
    return send(res, 200, createServicesAccount(await readBody(req)));
  }
  if (path === "/__mock/services") {
    // The rows as stored, for one business (tests check writes landed where they should).
    const tenantId = url.searchParams.get("tenant");
    if (req.method === "DELETE") {
      // Removes a row behind the app's back, as another browser tab or teammate would.
      const i = SERVICES.findIndex((s) => s.id === url.searchParams.get("id"));
      if (i >= 0) SERVICES.splice(i, 1);
      return send(res, 200, { ok: true });
    }
    return send(res, 200, SERVICES.filter((s) => s.tenant_id === tenantId));
  }
  if (path === "/__mock/kb-documents") {
    // kb_documents as stored, for one business; writes as the API and the ingest job would make them.
    const tenantId = url.searchParams.get("tenant");
    const docId = url.searchParams.get("id");
    if (req.method === "POST") {
      const { tenant_id, ...fields } = await readBody(req);
      const doc = kbDocument(tenant_id, fields);
      KB_DOCUMENTS.push(doc);
      return send(res, 201, doc);
    }
    const doc = KB_DOCUMENTS.find((d) => d.id === docId);
    if (req.method === "PATCH") {
      if (!doc) return send(res, 404, { msg: "no such document" });
      const { status, title, body, error } = await readBody(req);
      Object.assign(doc, Object.fromEntries(Object.entries({ status, title, body, error }).filter(([, v]) => v !== undefined)));
      return send(res, 200, doc);
    }
    if (req.method === "DELETE") {
      if (!doc) return send(res, 404, { msg: "no such document" });
      KB_DOCUMENTS.splice(KB_DOCUMENTS.indexOf(doc), 1);
      return send(res, 200, doc);
    }
    return send(res, 200, KB_DOCUMENTS.filter((d) => d.tenant_id === tenantId));
  }
  if (path === "/__mock/last-email") {
    const mail = outbox.get(String(url.searchParams.get("to") ?? "").toLowerCase());
    return mail ? send(res, 200, mail) : send(res, 404, { msg: "no email" });
  }
  if (path === "/auth/v1/user") {
    const email = emailFromToken(req.headers.authorization);
    if (!email) return send(res, 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    if (req.method === "PUT") {
      const { password } = await readBody(req);
      if (typeof password === "string") {
        if (password.length < 6) return send(res, 422, { code: 422, error_code: "weak_password", msg: "Password should be at least 6 characters.", weak_password: { reasons: ["length"] } });
        if (password === passwordOf(email)) return send(res, 422, { code: 422, error_code: "same_password", msg: "New password should be different from the old password." });
        USERS[email].password = password;
      }
    }
    return send(res, 200, userJson(email));
  }
  if (path === "/auth/v1/logout") {
    revoked.add((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    res.writeHead(204).end();
    return;
  }

  // PostgREST: row-level security is "the token's user sees their own rows".
  if (path.startsWith("/rest/v1/")) {
    const email = emailFromToken(req.headers.authorization);
    const table = path.slice("/rest/v1/".length);
    restLog.push({ email, method: req.method, table, query: url.search });
    if (table === "rpc/create_trial_tenant" || table === "rpc/credit_balance") {
      // EXECUTE is granted to service_role only.
      if ((req.headers.authorization ?? "") !== `Bearer ${SERVICE_ROLE_KEY}`) {
        return send(res, 403, { code: "42501", details: null, hint: null, message: `permission denied for function ${table.slice(4)}` });
      }
      const body = await readBody(req);
      if (table === "rpc/credit_balance") {
        const total = balances.get(body.p_tenant_id) ?? 0;
        return send(res, 200, [{ plan: total, topup: 0, total }]);
      }
      const [status, result] = createTrialTenant(body);
      return send(res, status, result);
    }
    if (table === "memberships") {
      // RLS as in 0001/0002: a member reads memberships (here only their own: each mock business has one
      // member) and updates only their own row's whatsapp_phone and takeover_pref; a row that isn't theirs
      // is left out of the update, so nothing comes back.
      if (!email) return send(res, 200, []);
      const user = USERS[email];
      const rowOf = ([t, role]) => ({ tenant_id: t.id, user_id: idOf(email), role, ...prefsOf(email, t.id), tenants: t });
      const rows = user.memberships.map(rowOf).filter(filters(url));
      if (req.method === "PATCH") {
        const patch = await readBody(req);
        if (Object.keys(patch).some((k) => !MEMBER_WRITABLE.includes(k))) {
          return send(res, 403, { code: "42501", details: null, hint: null, message: "permission denied for table memberships" });
        }
        if (user.prefsRefused) return send(res, 200, []);
        for (const r of rows) MEMBER_PREFS.set(`${email}|${r.tenant_id}`, { ...prefsOf(email, r.tenant_id), ...pick(patch, MEMBER_WRITABLE) });
        return send(res, 200, user.memberships.map(rowOf).filter(filters(url)));
      }
      // Only the Team screen selects whatsapp_phone, so sign-in's read of memberships is never broken.
      if (user.prefsError && (url.searchParams.get("select") ?? "").includes("whatsapp_phone")) {
        return send(res, 200, [{ tenant_id: "not-a-tenant", whatsapp_phone: 42 }]);
      }
      return send(res, 200, rows);
    }
    if (table === "whatsapp_connections_public") {
      if (!email) return send(res, 200, []);
      const view = USERS[email].view;
      if (view.delay) await new Promise((r) => setTimeout(r, view.delay));
      return send(res, view.status, view.body);
    }
    if (table === "kb_documents") {
      // RLS as in 0001: members read their own businesses' documents and write none.
      if (!email) return send(res, 200, []);
      if (req.method !== "GET") {
        return send(res, 403, { code: "42501", details: null, hint: null, message: 'new row violates row-level security policy for table "kb_documents"' });
      }
      if (USERS[email].kbDocumentsError) return send(res, 200, [{ id: "not-a-document", internal: "boom" }]);
      const own = new Set(USERS[email].memberships.map(([t]) => t.id));
      const tenantId = url.searchParams.get("tenant_id")?.replace(/^eq\./, "") ?? null;
      // source_type=eq.manual (FAQs) or neq.manual (documents); order=created_at.asc|desc.
      const [op, sourceType] = (url.searchParams.get("source_type") ?? "").split(/\.(.*)/);
      const rows = KB_DOCUMENTS.filter(
        (d) => own.has(d.tenant_id) && (!tenantId || d.tenant_id === tenantId) &&
          (!op || (op === "eq" ? d.source_type === sourceType : d.source_type !== sourceType)),
      );
      const ascending = url.searchParams.get("order") === "created_at.asc";
      return send(res, 200, [...rows].sort((a, b) => (ascending ? 1 : -1) * a.created_at.localeCompare(b.created_at)));
    }
    if (table === "tenants") {
      // RLS as in 0001/0002: members read their own businesses and may update only name, timezone,
      // business_hours and agent_settings.
      if (!email) return send(res, 200, []);
      const ownTenants = USERS[email].memberships.map(([t]) => t).filter(filters(url));
      const row = (t) => ({ ...t, business_hours: TENANT_EXTRA.get(t.id)?.business_hours ?? {}, vertical_version: TENANT_EXTRA.get(t.id)?.vertical_version ?? 1 });
      if (req.method === "PATCH") {
        const patch = await readBody(req);
        if (Object.keys(patch).some((k) => !["name", "timezone", "business_hours", "agent_settings"].includes(k))) {
          return send(res, 403, { code: "42501", details: null, hint: null, message: "permission denied for table tenants" });
        }
        for (const t of ownTenants) {
          if ("business_hours" in patch) TENANT_EXTRA.set(t.id, { vertical_version: 1, ...TENANT_EXTRA.get(t.id), business_hours: patch.business_hours });
        }
        return send(res, 200, ownTenants.map(row));
      }
      return send(res, 200, day3Rows(email, "tenants", ownTenants.map(row)));
    }
    if (table === "google_calendar_connections") {
      // 0017: members read their own businesses' rows, every column but refresh_token_enc; only the server writes.
      if (!email) return send(res, 200, []);
      const columns = (url.searchParams.get("select") ?? "*").split(",").map((c) => c.trim());
      if (req.method !== "GET" || columns.some((c) => !CALENDAR_READABLE.includes(c))) {
        return send(res, 401, { code: "42501", details: null, hint: null, message: "permission denied for table google_calendar_connections" });
      }
      const own = new Set(USERS[email].memberships.map(([t]) => t.id));
      return send(res, 200, CALENDARS.filter((c) => own.has(c.tenant_id)).filter(filters(url)).map((c) => pick(c, columns)));
    }
    if (table === "vertical_packs") {
      // A global catalogue every signed-in user reads (0001); only the server writes it.
      const service = (req.headers.authorization ?? "") === `Bearer ${SERVICE_ROLE_KEY}`;
      if (service && req.method === "POST") {
        // The API's startup pack sync: INSERT … ON CONFLICT (key, version) DO NOTHING, returning only
        // the rows that went in.
        const body = await readBody(req);
        const inserted = [];
        for (const row of Array.isArray(body) ? body : [body]) {
          if (PACKS.some((p) => p.key === row.key && p.version === row.version)) continue;
          const stored = { key: row.key, version: row.version, active: row.active ?? false, definition: row.definition };
          PACKS.push(stored);
          inserted.push(stored);
        }
        return send(res, 201, inserted.map((p) => selectPack(p, url.searchParams.get("select") ?? "*")));
      }
      if (!email && !service) return send(res, 200, []);
      if (req.method !== "GET") return send(res, 403, { code: "42501", details: null, hint: null, message: "permission denied for table vertical_packs" });
      if (email && USERS[email].packsError) {
        // Server-side read (the onboarding page), so this 5xx never reaches the browser console. A 500,
        // not a 503: supabase-js retries 503s, which would only slow the test down.
        return send(res, 500, { code: "XX000", details: null, hint: null, message: "boom" });
      }
      const rows = packsFor(email).filter(filters(url)).map((p) => selectPack(p, url.searchParams.get("select") ?? "*"));
      if (rows.some((r) => r === null)) {
        return send(res, 400, { code: "42703", details: null, hint: null, message: "column of vertical_packs does not exist" });
      }
      return send(res, 200, rows);
    }
    if (table === "leads") {
      if (!email) return send(res, 200, []);
      if (req.method !== "GET") return send(res, 403, { code: "42501", details: null, hint: null, message: "permission denied for table leads" });
      const own = new Set(USERS[email].memberships.map(([t]) => t.id));
      let found = LEADS.filter((l) => own.has(l.tenant_id))
        .filter(filters(url))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
      // The board pages by value: older than the last lead shown, or the same moment with a smaller id (supabase-js sends
      // `or=(updated_at.lt.X,and(updated_at.eq.X,id.lt.Y))`), newest first, `limit` rows at a time.
      const keyset = /^\(updated_at\.lt\.(.+),and\(updated_at\.eq\.(.+),id\.lt\.(.+)\)\)$/.exec(url.searchParams.get("or") ?? "");
      if (keyset) found = found.filter((l) => l.updated_at < keyset[1] || (l.updated_at === keyset[1] && l.id < keyset[3]));
      const rows = found.slice(0, Number(url.searchParams.get("limit") ?? Infinity)).map((l) => ({ ...l, contacts: contactOf(l.contact_id) }));
      return send(res, 200, day3Rows(email, "leads", rows));
    }
    if (table === "bookings") {
      // Members read; only the booking engine (service role) writes.
      if (!email) return send(res, 200, []);
      if (req.method !== "GET") return send(res, 403, { code: "42501", details: null, hint: null, message: "permission denied for table bookings" });
      const own = new Set(USERS[email].memberships.map(([t]) => t.id));
      const rows = BOOKINGS.filter((b) => own.has(b.tenant_id))
        .filter(filters(url))
        .sort((a, b) => a.start_at.localeCompare(b.start_at))
        .map(bookingWithEmbeds);
      return send(res, 200, day3Rows(email, "bookings", rows));
    }
    if (table === "resources") {
      // RLS as in 0001/0002: members read and write their own businesses' rows only.
      if (!email) return send(res, 200, []);
      const own = new Set(USERS[email].memberships.map(([t]) => t.id));
      const COLUMNS = ["id", "tenant_id", "type", "name", "working_hours", "service_area", "active"];
      const mine = () => RESOURCES.filter((r) => own.has(r.tenant_id)).filter(filters(url));
      if (req.method === "GET") {
        return send(res, 200, day3Rows(email, "resources", mine().sort((a, b) => a.name.localeCompare(b.name)).map((r) => pick(r, COLUMNS))));
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const rows = Array.isArray(body) ? body : [body];
        if (rows.some((r) => !own.has(r.tenant_id))) {
          return send(res, 403, { code: "42501", details: null, hint: null, message: 'new row violates row-level security policy for table "resources"' });
        }
        const created = rows.map((r) => resourceRow(r.tenant_id, { ...r, id: randomUUID() }));
        RESOURCES.push(...created);
        return send(res, 201, created.map((r) => pick(r, COLUMNS)));
      }
      if (req.method === "PATCH") {
        const patch = await readBody(req);
        const updated = mine();
        for (const r of updated) Object.assign(r, patch, { id: r.id, tenant_id: r.tenant_id });
        return send(res, 200, updated.map((r) => pick(r, COLUMNS)));
      }
      if (req.method === "DELETE") {
        const removed = mine();
        // bookings.resource_id references resources with no cascade: Postgres refuses the delete.
        if (removed.some((r) => BOOKINGS.some((b) => b.resource_id === r.id))) {
          return send(res, 409, {
            code: "23503", details: 'Key is still referenced from table "bookings".', hint: null,
            message: 'update or delete on table "resources" violates foreign key constraint "bookings_resource_id_fkey" on table "bookings"',
          });
        }
        for (const r of removed) RESOURCES.splice(RESOURCES.indexOf(r), 1);
        return send(res, 200, removed.map((r) => ({ id: r.id })));
      }
    }
    if (table === "services") {
      // RLS as in 0001/0002: members read and write their own businesses' rows only. Filters: eq.
      if (!email) return send(res, 200, []);
      const own = new Set(USERS[email].memberships.map(([t]) => t.id));
      const eq = (column) => url.searchParams.get(column)?.replace(/^eq\./, "") ?? null;
      // Rows the app can't parse (a 5xx would also log a browser console error, which the suite forbids).
      if (USERS[email].servicesError) return send(res, 200, [{ id: "not-a-service", internal: "boom" }]);
      const matches = (s) =>
        own.has(s.tenant_id) && (!eq("tenant_id") || s.tenant_id === eq("tenant_id")) && (!eq("id") || s.id === eq("id"));
      if (req.method === "GET") {
        return send(res, 200, SERVICES.filter(matches).sort((a, b) => a.name.localeCompare(b.name)).map(pickService));
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const rows = Array.isArray(body) ? body : [body];
        if (rows.some((r) => !own.has(r.tenant_id))) {
          return send(res, 403, { code: "42501", details: null, hint: null, message: 'new row violates row-level security policy for table "services"' });
        }
        const created = rows.map((r) => ({ active: true, price_min: null, price_max: null, buffer_min: 0, min_notice_min: 60, ...r, id: randomUUID() }));
        SERVICES.push(...created);
        return send(res, 201, created.map(pickService));
      }
      if (req.method === "PATCH") {
        const patch = await readBody(req);
        const updated = SERVICES.filter(matches);
        for (const s of updated) Object.assign(s, patch, { id: s.id, tenant_id: s.tenant_id });
        return send(res, 200, updated.map(pickService));
      }
      if (req.method === "DELETE") {
        const removed = SERVICES.filter(matches);
        for (const s of removed) SERVICES.splice(SERVICES.indexOf(s), 1);
        return send(res, 200, removed.map((s) => ({ id: s.id })));
      }
    }
    if (table === "conversations" || table === "messages") {
      if (!email) return send(res, 200, []);
      // Rows the app can't parse (a 500 would also log a browser console error, which the suite forbids).
      if (USERS[email].inboxError) return send(res, 200, [{ id: "not-a-conversation", internal: "boom" }]);
      // RLS: only the user's own businesses; then the query's own filters.
      const own = new Set(USERS[email].memberships.map(([t]) => t.id));
      const rows = (table === "conversations" ? INBOX.conversations : INBOX.messages).filter((r) => own.has(r.tenant_id)).filter(filters(url));
      const limit = Number(url.searchParams.get("limit") ?? Infinity);
      if (table === "conversations" && url.searchParams.has("contact_id")) {
        // The lead timeline: one contact's conversations with every handover, open or closed.
        return send(res, 200, rows.map(({ handoffs, ...c }) => ({
          ...c,
          handoffs: handoffs.map(({ id, trigger, picked_at = null, resolved_at }) => ({ id, trigger, picked_at, resolved_at })),
        })));
      }
      return table === "conversations"
        ? send(res, 200, rows.map(inboxListRow))
        : send(res, 200, [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit));
    }
    return send(res, 404, { code: "PGRST205", details: null, hint: null, message: `Could not find the table 'public.${table}' in the schema cache` });
  }
  send(res, 404, { msg: "not found" });
}).listen(PORT, "127.0.0.1", () => console.log(`mock supabase on http://127.0.0.1:${PORT}`));

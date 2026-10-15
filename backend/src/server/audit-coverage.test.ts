import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTES } from "./routes";

// 9-day plan, Day 7: "Audit logs for every business-traceable action." Every route that changes something names the audit_logs action it
// writes and the file that writes it, and this checks the file still does. A new write route fails here until it is listed: audited, or
// with the reason it has nothing to audit. Changes the dashboard makes straight to the database (row-level security, no route) are
// audited by the 0049 trigger (supabase/tests/browser_write_audit.test.sql). A GET that changes something is listed by hand below.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface Audited {
  /** The action(s) written, as they appear in audit_logs. */
  actions: string[];
  /** Repo-relative file that writes them, and the text that proves it (defaults to each action in quotes). */
  file: string;
  proof?: string[];
}
type Coverage = Audited | { none: string };

const SETTLED: Audited = {
  actions: ["payment.succeeded", "payment.failed"],
  file: "supabase/migrations/0036_payment_settlement.sql",
};
const sql = (file: string, ...actions: string[]): Audited => ({ actions, file: `supabase/migrations/${file}` });
const ts = (file: string, ...actions: string[]): Audited => ({ actions, file: `backend/src/${file}` });

const COVERAGE: Record<string, Coverage> = {
  "POST /api/templates": ts("notify/templates.ts", "template.submitted"),
  "POST /api/messages/test": sql("0032_platform_number_fallback.sql", "test_message.sent"),
  "POST /api/onboarding/trial": ts("billing/trial.ts", "tenant.created"),
  "POST /api/conversations/:id/messages": {
    actions: ["staff_reply.sent"],
    file: "supabase/migrations/0009_notify_functions.sql",
    proof: ["p_kind || '.sent'"],
  },
  "POST /api/conversations/:id/mode": ts("conversations/mode.ts", "conversation.mode_changed"),
  "POST /api/contacts/:id/deletion": sql("0043_contact_deletion.sql", "contact.deleted"),
  "POST /api/conversations/:id/suggest": { none: "drafts a reply for the member to edit: nothing is sent or saved" },
  // A payment row records who started it; settle_payment audits how it ended (and the return and the webhook only settle).
  "POST /api/billing/checkout": SETTLED,
  "POST /api/billing/topup": SETTLED,
  "POST /api/billing/setup-fee": SETTLED,
  "POST /api/billing/change-plan": sql("0038_plan_change.sql", "subscription.downgrade_scheduled", "subscription.downgrade_cancelled", "payment.succeeded"),
  "POST /api/billing/cancel": sql("0042_billing_cancel.sql", "subscription.cancel_requested"),
  "POST /api/billing/resume": sql("0042_billing_cancel.sql", "subscription.resumed"),
  "POST /api/billing/payu/return": SETTLED,
  "POST /api/webhooks/payu": SETTLED,
  "PATCH /api/features/:key": sql("0025_set_tenant_feature.sql", "feature.toggled", "feature.settings_changed"),
  "POST /api/kb/documents": ts("server/routes.ts", "kb.document_uploaded"),
  "DELETE /api/kb/documents/:id": ts("server/routes.ts", "kb.document_deleted"),
  "POST /api/kb/faqs": ts("server/routes.ts", "kb.faq_created"),
  "PATCH /api/kb/faqs/:id": ts("server/routes.ts", "kb.faq_updated"),
  "DELETE /api/kb/faqs/:id": ts("server/routes.ts", "kb.faq_deleted"),
  "POST /api/kb/gaps/:id/answer": ts("server/routes.ts", "kb.gap_answered"),
  "POST /api/kb/gaps/:id/dismiss": ts("server/routes.ts", "kb.gap_dismissed"),
  "POST /api/whatsapp/manual": ts("channels/whatsapp/connect/manual.ts", "whatsapp_connection.connected"),
  "POST /api/onboarding/whatsapp/embedded-signup": ts("channels/whatsapp/connect/embedded-signup.ts", "whatsapp_connection.connected"),
  "POST /api/admin/whatsapp/connect-link": ts("channels/whatsapp/connect/connect-link.ts", "whatsapp_connect_link.created"),
  "POST /api/whatsapp/connections/:id/recheck": ts("channels/whatsapp/connect/recheck.ts", "whatsapp_connection.rechecked"),
  "POST /api/whatsapp/connections/:id/disconnect": ts("channels/whatsapp/connect/recheck.ts", "whatsapp_connection.disconnected"),
  "POST /api/admin/tenants/:id/extend-trial": sql("0041_admin_billing.sql", "tenant.trial_extended"),
  "POST /api/admin/tenants/:id/credits": sql("0041_admin_billing.sql", "credits.granted"),
  "PATCH /api/admin/plans/:key": sql("0041_admin_billing.sql", "plan.updated"),
  "PATCH /api/admin/features/:key": sql("0041_admin_billing.sql", "feature.updated"),
  "POST /api/admin/whatsapp/manual": ts("channels/whatsapp/connect/manual.ts", "whatsapp_connection.connected"),
  "POST /api/bookings/:id/reschedule": sql("0026_booking_actions.sql", "booking.rescheduled"),
  "POST /api/bookings/:id/cancel": sql("0026_booking_actions.sql", "booking.cancelled"),
  "POST /api/bookings/:id/complete": sql("0026_booking_actions.sql", "booking.completed"),
  "POST /api/bookings/:id/no-show": sql("0026_booking_actions.sql", "booking.no_show"),
  "POST /api/webhooks/whatsapp": {
    none: "a customer's messages and Meta's statuses are kept as messages and events; the reply that follows audits itself (message.answered, handoff.opened, lead.stage_changed, bookings)",
  },
  "POST /api/inngest": { none: "Inngest running a function; each function audits its own actions" },
  "PUT /api/inngest": { none: "Inngest syncing the function list; nothing of a business changes" },
  // GETs that change something:
  "GET /h/:token": ts("agent/handoff/takeover.ts", "handoff.picked"),
  "GET /api/calendar/google/callback": ts("booking/google-calendar.ts", "google_calendar.connected"),
};

const WRITING_GETS = Object.keys(COVERAGE).filter((k) => k.startsWith("GET "));

const writeRoutes = (): string[] =>
  ROUTES.flatMap((route) =>
    Object.keys(route.methods)
      .filter((method) => method !== "GET" || WRITING_GETS.includes(`GET ${route.path}`))
      .map((method) => `${method} ${route.path}`),
  );

describe("audit coverage: every route that changes something is audited", () => {
  it("lists every write route in the route table, and nothing that is not one", () => {
    expect([...writeRoutes()].sort()).toEqual(Object.keys(COVERAGE).sort());
  });

  for (const [route, coverage] of Object.entries(COVERAGE)) {
    if ("none" in coverage) {
      it(`${route}: nothing to audit (${coverage.none.split(":")[0]})`, () => expect(coverage.none.length).toBeGreaterThan(20));
      continue;
    }
    it(`${route} → ${coverage.actions.join(", ")}`, () => {
      const source = readFileSync(`${ROOT}${coverage.file}`, "utf8");
      for (const proof of coverage.proof ?? coverage.actions.map((a) => (coverage.file.endsWith(".sql") ? `'${a}'` : `"${a}"`))) {
        expect(source, `${coverage.file} no longer writes ${proof}`).toContain(proof);
      }
    });
  }
});

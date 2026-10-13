import type { StartTrialResult } from "@pakka/types";
import { handleHandoffLink } from "../agent/handoff/takeover";
import { getLeadCard } from "../agent/leadcard/route";
import { suggestReply } from "../agent/leadcard/suggest";
import { accountStatus } from "../billing/account-status";
import { changePlan, handlePayuReturn, handlePayuWebhook, paymentStatus, startCheckout, startSetupFee, startTopup } from "../billing/checkout";
import { getBalance } from "../billing/credits";
import { startTrialFor } from "../billing/start-trial";
import { createTrialTenant } from "../billing/trial";
import { cancelFromCalendar, completeFromCalendar, noShowFromCalendar, rescheduleFromCalendar, slotsForMove } from "../booking/actions";
import { googleConnectUrl, handleGoogleCallback } from "../booking/google-calendar";
import { sendTestMessage } from "../channels/whatsapp/test-message";
import { handleWhatsAppWebhook } from "../channels/whatsapp/inbound";
import { assertConnectLinksAvailable, connectWithLink, createConnectLink, readConnectLink } from "../channels/whatsapp/connect/connect-link";
import { clientKey } from "../channels/whatsapp/connect/connect-link-rate-limit";
import { connectEmbeddedSignup } from "../channels/whatsapp/connect/embedded-signup";
import { connectManual } from "../channels/whatsapp/connect/manual";
import { disconnectConnection, recheckConnection } from "../channels/whatsapp/connect/recheck";
import { getWebhookConfig } from "../channels/whatsapp/connect/webhook-token";
import { handleWhatsAppHandshake } from "../channels/whatsapp/verify-challenge";
import { setConversationMode } from "../conversations/mode";
import { dashboardSummary } from "../dashboard/summary";
import { sendStaffReply } from "../conversations/staff-reply";
import { conversationTemplates } from "../conversations/templates";
import { listFeatures, updateFeature } from "../features/toggles";
import { deleteDocument, KB_UPLOAD_MAX_BODY_BYTES, uploadDocument } from "../kb/documents";
import { answerGap, createFaq, deleteFaq, dismissGap, listGaps, updateFaq } from "../kb/faqs";
import { serverEnv } from "../lib/env";
import { requireRole, resolveTenant } from "../lib/tenant";
import { createTemplate } from "../notify/templates";
import { adminRoute, authenticate, optionalJson, readJson, requireTenant, tenantRoute, type UserClientFactory } from "./auth";

// Every HTTP endpoint of the API. A route only parses the request and calls a backend service;
// business logic stays in the modules it imports.

export interface RouteDeps {
  userClient: UserClientFactory;
  inngest: (request: Request) => Promise<Response>;
}

/** The values of a route's `:name` segments, decoded. */
export type RouteParams = Readonly<Record<string, string>>;
export type RouteHandler = (request: Request, deps: RouteDeps, params: RouteParams) => Promise<Response> | Response;
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Route {
  /**
   * A fixed path, or a pattern with `:name` segments (`/api/kb/faqs/:id`) that match one non-empty
   * segment each. A fixed path wins over a pattern; otherwise the first matching route wins.
   */
  path: string;
  methods: Partial<Record<Method, RouteHandler>>;
  /** Called from the browser: CORS applies, and only allowed origins may call it. */
  browser?: boolean;
  /** The largest body accepted, in bytes; bigger requests get 413 before the route runs. Default 1 MB. */
  maxBodyBytes?: number;
  /** Path params that are secrets (a connect-link token): the request log shows them as `***`. */
  secretParams?: readonly string[];
}

// Liveness for Railway's healthcheck. Reads nothing else, so it answers even when Supabase or Inngest
// are down. RAILWAY_* are set by the platform.
function health(): Response {
  return Response.json(
    {
      ok: true,
      env: process.env.RAILWAY_ENVIRONMENT_NAME ?? "local",
      commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

const TRIAL_STATUS: Record<StartTrialResult["status"], number> = {
  ready: 200,
  has_business: 409,
  unavailable: 422,
  invalid: 422,
  failed: 500,
};

// POST /api/onboarding/trial { name, industry } → StartTrialResult. A signed-in account with no
// business yet; the user comes from the verified token, never from the body.
async function startTrial(request: Request, deps: RouteDeps): Promise<Response> {
  const { supabase, user } = await authenticate(request, deps.userClient);
  const body = await readJson(request);
  const result = await startTrialFor(body, {
    currentUser: async () => user,
    sessionState: () => resolveTenant(supabase, user),
    createTrialTenant,
    getBalance,
  });
  return Response.json(result, { status: TRIAL_STATUS[result.status] });
}

// { name, category, language, body, examples } → CreateTemplateResult. Owner or admin.
const templates = tenantRoute(({ context, body }) => createTemplate(context, body));
// { to, body } → SendTestMessageResult. Owner or admin.
const testMessage = tenantRoute(({ supabase, context, body }) => sendTestMessage(supabase, context, body));
// { body } → SendStaffReplyResult. Owner, admin or staff; free text inside the 24-hour window only.
const staffReply: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context, body, params: p }) => sendStaffReply(context, p.id, body))(request, deps.userClient, params);
// → { connectionId, templates }: the approved templates this chat's WhatsApp number can send, for the inbox's picker. Any member.
const conversationTemplateList: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context, params: p }) => conversationTemplates(context, p.id))(request, deps.userClient, params);
// { mode: "ai" | "human" } → SetConversationModeResult. Owner, admin or staff; takeover or Return to AI, with a system note.
const conversationMode: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context, body, params: p }) => setConversationMode(context, p.id, body))(request, deps.userClient, params);
// → LeadCard (docs/dashboard-screen-contracts.md, Inbox): the card pinned beside a chat, so staff need not read it. Owner, admin or staff; free. Read only.
const conversationLeadCard: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context, params: p }) => getLeadCard(context, p.id))(request, deps.userClient, params);
// no body → { reply, language, reason }: a reply staff can send as it is (the lead card's suggested reply). Owner, admin or staff; free; nothing is sent.
// The browser sends a POST with no body, so this authenticates itself like the other body-less routes.
const conversationSuggest: RouteHandler = async (request, deps, params) => {
  const { context } = await requireTenant(request, deps.userClient);
  return Response.json(await suggestReply(context, params.id));
};
// → AccountStatus: the balance, the meter's denominator, renewal and trial dates, and whether the assistant is paused. Any member.
const billingBalance = tenantRoute(({ context }) => accountStatus(context));
// PayU billing (billing/checkout.ts, decision 20). Owner only; each answers PayuCheckout, which the browser posts to PayU.
// { planKey, cycle, phone? }: the plan's first payment, which also approves the auto-debit.
const billingCheckout = tenantRoute(({ context, body }) => startCheckout(context, body));
// { phone? } or no body: 1,000 credits, for a business on a paid plan. Like the other body-optional routes, these
// authenticate themselves and let the app turn a thrown error into the envelope.
const billingTopup: RouteHandler = async (request, deps) => {
  const { context } = await requireTenant(request, deps.userClient);
  return Response.json(await startTopup(context, await optionalJson(request)));
};
// { phone? } or no body: the assisted-onboarding setup fee, once.
const billingSetupFee: RouteHandler = async (request, deps) => {
  const { context } = await requireTenant(request, deps.userClient);
  return Response.json(await startSetupFee(context, await optionalJson(request)));
};
// { planKey, cycle?, phone? } → ChangePlanResult: an upgrade now (PayU: the rest of the period's difference and a new
// auto-debit), a downgrade at the next renewal, or cancelling a scheduled downgrade. Owner only.
const billingChangePlan = tenantRoute(({ context, body }) => changePlan(context, body));
// → PaymentView: one payment, for the Billing screen after PayU sends the payer back (asks PayU again while not final). Any member.
const billingPayment: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context, params: p }) => paymentStatus(context, p.id))(request, deps.userClient, params);
// → DashboardSummary: the month's numbers, last night's chats, hot leads and today's bookings (staff: their own). Any member.
const homeSummary = tenantRoute(({ context }) => dashboardSummary(context));
// → FeatureList: every feature with what the plan includes, the business's switch and settings, and the credits it
// spent in the last 30 days. Any member.
const featureList = tenantRoute(({ context }) => listFeatures(context));
// { enabled?, settings? } → FeatureRow. Owner or admin; a feature outside the plan cannot be switched on (plan_required),
// and every change is in the audit log.
const featureUpdate: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context, body, params: p }) => updateFeature(context, p.key, body))(request, deps.userClient, params);
// The calendar's buttons (booking/actions.ts). Owners and admins on any booking of the business, staff on their own
// calendar's; each sends booking.changed so the jobs follow. Complete and no-show have no body, and cancel's is
// optional, so those three authenticate themselves (like the gap routes) and let the app turn an error into the envelope.
// { start, end, resourceId? } → Booking: the new confirmed booking.
const bookingReschedule: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context, body, params: p }) => rescheduleFromCalendar(context, p.id, body))(request, deps.userClient, params);
// { reason? } or no body → Booking (cancelled).
const bookingCancel: RouteHandler = async (request, deps, params) => {
  const { context } = await requireTenant(request, deps.userClient);
  return Response.json(await cancelFromCalendar(context, params.id, await optionalJson(request)));
};
// no body → Booking (completed; the lead moves to visited).
const bookingComplete: RouteHandler = async (request, deps, params) => {
  const { context } = await requireTenant(request, deps.userClient);
  return Response.json(await completeFromCalendar(context, params.id));
};
// no body → Booking (no_show; the rebooking offer follows).
const bookingNoShow: RouteHandler = async (request, deps, params) => {
  const { context } = await requireTenant(request, deps.userClient);
  return Response.json(await noShowFromCalendar(context, params.id));
};
// ?from=&to= → { slots }: up to 3 free times for the booking's service, a week from now by default.
const bookingSlots: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context, params: p }) => slotsForMove(context, p.id, new URL(request.url).searchParams))(request, deps.userClient, params);
// ?resourceId= → { url }: the Google consent link for one staff member. Owner or admin.
const googleConnect: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context }) => googleConnectUrl(context, new URL(request.url).searchParams.get("resourceId")))(request, deps.userClient, params);

// multipart: file (+ optional title) → 202 { id, title, sourceType, status: "processing", createdAt }. Owner or
// admin. The body is a form, not JSON, so this reads it itself, after the caller and the business are known.
const kbUpload: RouteHandler = async (request, deps) => {
  const { context } = await requireTenant(request, deps.userClient);
  return Response.json(await uploadDocument(context, request), { status: 202 });
};
// → 204. Owner or admin; an upload or imported document and its chunks (an FAQ has its own route).
const kbDeleteDocument: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context }) => deleteDocument(context, params.id), { status: 204 })(request, deps.userClient, params);

// { q, a } → 201 { id, q, a }. Owner or admin. A question the business already has is `conflict`; an embedding failure is `upstream_failed`.
const kbCreateFaq = tenantRoute(({ context, body }) => createFaq(context, body), { status: 201 });
// { q?, a? } → { id, q, a }. Owner or admin.
const kbUpdateFaq: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context, body, params: p }) => updateFaq(context, p.id, body))(request, deps.userClient, params);
// → 204. Owner or admin; a FAQ of the business (an upload has its own route).
const kbDeleteFaq: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context, params: p }) => deleteFaq(context, p.id), { status: 204 })(request, deps.userClient, params);
// → [{ id, question, askedCount, lastAskedBy }], open gaps, most asked first. Owner, admin or staff.
const kbListGaps = tenantRoute(({ context }) => listGaps(context));
// { a } → { faq: { id, q, a } }; the gap is closed in the same transaction. Owner, admin or staff.
const kbAnswerGap: RouteHandler = (request, deps, params) =>
  tenantRoute(({ context, body, params: p }) => answerGap(context, p.id, body))(request, deps.userClient, params);
// → 204. Owner, admin or staff. The browser sends a POST with no body, so this does not read JSON (like the upload route,
// it authenticates itself and lets the app turn a thrown error into the envelope).
const kbDismissGap: RouteHandler = async (request, deps, params) => {
  const { context } = await requireTenant(request, deps.userClient);
  await dismissGap(context, params.id);
  return new Response(null, { status: 204 });
};

// → { webhookUrl, verifyToken, partnerBusinessId }: what a client pastes into their own Meta app. Owner or admin. The
// verify token belongs to this business only; the platform-wide token is never returned.
const whatsappWebhookConfig = tenantRoute(({ context }) => getWebhookConfig(context, serverEnv()));
// { wabaId, phoneNumberId, token, tokenType, appSecret, ... } → 201 connection. Owner or admin; the business is the
// caller's own (a tenantId in the body is overwritten). The secrets are encrypted here and never returned.
const whatsappManualConnect = tenantRoute(
  ({ context, body }) => {
    requireRole(context, ["owner", "admin"], "connect WhatsApp");
    const input = typeof body === "object" && body !== null ? body : {};
    return connectManual({ ...input, tenantId: context.tenant.id }, context.user.id);
  },
  { status: 201 },
);
// { code, wabaId, phoneNumberId, coexistence } → 201 connection. Owner or admin; off (not_available) until EMBEDDED_SIGNUP_ENABLED. With a `connectToken` in the
// body it is the assisted flow instead: public, no bearer token, the business comes from the link (connect/connect-link.ts).
const signedInEmbeddedSignup = tenantRoute(({ context, body }) => connectEmbeddedSignup(context, body), { status: 201 });
const whatsappEmbeddedSignup: RouteHandler = async (request, deps) => {
  const peek: unknown = await request.clone().json().catch(() => null);
  if (typeof peek === "object" && peek !== null && "connectToken" in peek) {
    return Response.json(await connectWithLink(await readJson(request), clientKey(request)), { status: 201 });
  }
  return signedInEmbeddedSignup(request, deps.userClient);
};
// { tenantId } → 201 { url, expiresAt }. Platform admin; not_available while the flag is off, before anyone is looked up.
const adminConnectLink: RouteHandler = async (request, deps) => {
  assertConnectLinksAvailable();
  return adminRoute(({ admin, body }) => createConnectLink({ actor: admin.actor, userId: admin.user.id }, body), { status: 201 })(request, deps.userClient);
};
// Public, no bearer token → { tenantName, expiresAt }; every link that cannot be used gets the same not_found.
const connectLinkRead: RouteHandler = async (request, _deps, params) => Response.json(await readConnectLink(params.token ?? "", clientKey(request)));
// no body → 200 connection. Owner or admin of the business that owns it. The browser sends a POST with no body, so (like the gap routes) these
// authenticate themselves and let the app turn a thrown error into the envelope.
const whatsappRecheck: RouteHandler = async (request, deps, params) => {
  const { context } = await requireTenant(request, deps.userClient);
  return Response.json(await recheckConnection(context, params.id));
};
const whatsappDisconnect: RouteHandler = async (request, deps, params) => {
  const { context } = await requireTenant(request, deps.userClient);
  return Response.json(await disconnectConnection(context, params.id));
};
// { tenantId, ... } → 201 connection. Platform admin only (docs/whatsapp-connection-contract.md).
const adminManualConnect = adminRoute(({ admin, body }) => connectManual(body, admin.actor), { status: 201 });

export const ROUTES: readonly Route[] = [
  { path: "/api/health", methods: { GET: health } },
  { path: "/api/templates", browser: true, methods: { POST: (request, deps) => templates(request, deps.userClient) } },
  { path: "/api/messages/test", browser: true, methods: { POST: (request, deps) => testMessage(request, deps.userClient) } },
  { path: "/api/onboarding/trial", browser: true, methods: { POST: startTrial } },
  // 6 MB: room for a 5 MB file plus its multipart wrapping; the service checks the 5 MB itself, so a big file
  // is a validation_failed with fields.file, and only a body over 6 MB is refused by the server (413).
  { path: "/api/conversations/:id/messages", browser: true, methods: { POST: staffReply } },
  { path: "/api/conversations/:id/templates", browser: true, methods: { GET: conversationTemplateList } },
  { path: "/api/conversations/:id/mode", browser: true, methods: { POST: conversationMode } },
  { path: "/api/conversations/:id/lead-card", browser: true, methods: { GET: conversationLeadCard } },
  { path: "/api/conversations/:id/suggest", browser: true, methods: { POST: conversationSuggest } },
  { path: "/api/billing/balance", browser: true, methods: { GET: (request, deps) => billingBalance(request, deps.userClient) } },
  { path: "/api/billing/checkout", browser: true, methods: { POST: (request, deps) => billingCheckout(request, deps.userClient) } },
  { path: "/api/billing/topup", browser: true, methods: { POST: billingTopup } },
  { path: "/api/billing/setup-fee", browser: true, methods: { POST: billingSetupFee } },
  { path: "/api/billing/change-plan", browser: true, methods: { POST: (request, deps) => billingChangePlan(request, deps.userClient) } },
  { path: "/api/billing/payments/:id", browser: true, methods: { GET: billingPayment } },
  // PayU's surl and furl: the payer's browser posts here from PayU's page (a navigation, not a fetch, so not `browser`).
  // Nothing posted is trusted: the server asks PayU, then redirects to the Billing screen.
  { path: "/api/billing/payu/return", methods: { POST: (request) => handlePayuReturn(request) } },
  // PayU's webhook, server to server: the posted txnid is verified with PayU before anything changes.
  { path: "/api/webhooks/payu", methods: { POST: (request) => handlePayuWebhook(request) } },
  { path: "/api/dashboard/summary", browser: true, methods: { GET: (request, deps) => homeSummary(request, deps.userClient) } },
  { path: "/api/features", browser: true, methods: { GET: (request, deps) => featureList(request, deps.userClient) } },
  { path: "/api/features/:key", browser: true, methods: { PATCH: featureUpdate } },
  { path: "/api/kb/documents", browser: true, maxBodyBytes: KB_UPLOAD_MAX_BODY_BYTES, methods: { POST: kbUpload } },
  { path: "/api/kb/documents/:id", browser: true, methods: { DELETE: kbDeleteDocument } },
  { path: "/api/kb/faqs", browser: true, methods: { POST: (request, deps) => kbCreateFaq(request, deps.userClient) } },
  { path: "/api/kb/faqs/:id", browser: true, methods: { PATCH: kbUpdateFaq, DELETE: kbDeleteFaq } },
  { path: "/api/kb/gaps", browser: true, methods: { GET: (request, deps) => kbListGaps(request, deps.userClient) } },
  { path: "/api/kb/gaps/:id/answer", browser: true, methods: { POST: kbAnswerGap } },
  { path: "/api/kb/gaps/:id/dismiss", browser: true, methods: { POST: kbDismissGap } },
  { path: "/api/whatsapp/webhook-config", browser: true, methods: { GET: (request, deps) => whatsappWebhookConfig(request, deps.userClient) } },
  { path: "/api/whatsapp/manual", browser: true, methods: { POST: (request, deps) => whatsappManualConnect(request, deps.userClient) } },
  { path: "/api/onboarding/whatsapp/embedded-signup", browser: true, methods: { POST: whatsappEmbeddedSignup } },
  { path: "/api/connect-links/:token", browser: true, secretParams: ["token"], methods: { GET: connectLinkRead } },
  { path: "/api/admin/whatsapp/connect-link", browser: true, methods: { POST: adminConnectLink } },
  { path: "/api/whatsapp/connections/:id/recheck", browser: true, methods: { POST: whatsappRecheck } },
  { path: "/api/whatsapp/connections/:id/disconnect", browser: true, methods: { POST: whatsappDisconnect } },
  { path: "/api/admin/whatsapp/manual", browser: true, methods: { POST: (request, deps) => adminManualConnect(request, deps.userClient) } },
  // The two buttons of a staff alert (module 6). No login: the signed token says who tapped and which handoff. Answers are redirects or friendly pages.
  { path: "/h/:token", secretParams: ["token"], methods: { GET: (request, _deps, params) => handleHandoffLink(request, { token: params.token }) } },
  { path: "/api/bookings/:id/reschedule", browser: true, methods: { POST: bookingReschedule } },
  { path: "/api/bookings/:id/cancel", browser: true, methods: { POST: bookingCancel } },
  { path: "/api/bookings/:id/complete", browser: true, methods: { POST: bookingComplete } },
  { path: "/api/bookings/:id/no-show", browser: true, methods: { POST: bookingNoShow } },
  { path: "/api/bookings/:id/slots", browser: true, methods: { GET: bookingSlots } },
  { path: "/api/calendar/google/connect", browser: true, methods: { GET: googleConnect } },
  // Google sends the browser here after consent (no login: the signed state says who asked). Every answer
  // is a redirect back to the dashboard. The code and state are in the query string, which is never logged.
  { path: "/api/calendar/google/callback", methods: { GET: (request) => handleGoogleCallback(request) } },
  {
    // Meta's callback URL. GET is the verification check; POST delivers messages and statuses (the
    // signature is verified in the handler). Server to server: not `browser`, so no CORS; default body limit.
    path: "/api/webhooks/whatsapp",
    methods: {
      GET: (request) => handleWhatsAppHandshake(request),
      POST: (request) => handleWhatsAppWebhook(request),
    },
  },
  {
    // Inngest syncs (PUT), introspects (GET) and runs functions (POST) here.
    path: "/api/inngest",
    methods: { GET: (r, d) => d.inngest(r), POST: (r, d) => d.inngest(r), PUT: (r, d) => d.inngest(r) },
  },
];

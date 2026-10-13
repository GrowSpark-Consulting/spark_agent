import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Route drift guard. Reads the backend's route table (backend/src/server/routes.ts, the only place an endpoint is registered) as
// text, the way the leads contract-shape tests read the migrations, and checks three things:
//
//   1. Every call the frontend makes names a method and path the API registers (a typo, a rename or a removed route fails here,
//      not in a customer's browser).
//   2. Every frontend file that talks to the API through lib/api/client.ts is listed below, so a new caller can't appear unreviewed.
//   3. Every backend route is either called by the frontend or listed as having no browser caller, with the reason. A new route
//      fails here until someone decides which it is.
//
// What this does NOT show: that a request or response has the right shape (the callers' own tests and their zod parsers do that),
// or that a route works. It only keeps the two sides' lists of routes from drifting apart.

const FRONTEND = fileURLToPath(new URL("../../", import.meta.url));
const ROUTES_FILE = join(FRONTEND, "..", "backend", "src", "server", "routes.ts");

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS: readonly Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** `METHOD path` for every route the backend registers. Comments are dropped first, so a method named in prose isn't read as one. */
export function parseBackendRoutes(source: string): string[] {
  const table = source.slice(source.indexOf("export const ROUTES"));
  const code = table.replace(/\/\/[^\n]*/g, "");
  const starts = [...code.matchAll(/\bpath:\s*"([^"]+)"/g)];
  const found: string[] = [];
  starts.forEach((match, i) => {
    const entry = code.slice(match.index, starts[i + 1]?.index ?? code.length);
    const methods = entry.slice(Math.max(entry.indexOf("methods:"), 0));
    for (const method of METHODS) if (new RegExp(`\\b${method}\\s*:`).test(methods)) found.push(`${method} ${match[1]}`);
  });
  return found.sort();
}

/** Every call the dashboard makes to the API, and the one file that makes it. */
const FRONTEND_CALLS: { call: string; file: string }[] = [
  { call: "POST /api/templates", file: "components/dashboard/create-template-form.tsx" },
  { call: "POST /api/messages/test", file: "components/dashboard/send-test-message-form.tsx" },
  { call: "POST /api/onboarding/trial", file: "lib/onboarding/trial.ts" },
  { call: "POST /api/conversations/:id/messages", file: "features/inbox/staff-reply.ts" },
  { call: "POST /api/conversations/:id/mode", file: "features/inbox/conversation-mode.ts" },
  { call: "GET /api/conversations/:id/lead-card", file: "features/inbox/lead-card-api.ts" },
  { call: "POST /api/conversations/:id/suggest", file: "features/inbox/suggest-reply.ts" },
  { call: "POST /api/kb/documents", file: "features/knowledge/kb-content.ts" },
  { call: "DELETE /api/kb/documents/:id", file: "features/knowledge/kb-content.ts" },
  { call: "POST /api/kb/faqs", file: "features/knowledge/kb-content.ts" },
  { call: "PATCH /api/kb/faqs/:id", file: "features/knowledge/kb-content.ts" },
  { call: "DELETE /api/kb/faqs/:id", file: "features/knowledge/kb-content.ts" },
  { call: "GET /api/kb/gaps", file: "features/knowledge/kb-content.ts" },
  { call: "POST /api/kb/gaps/:id/answer", file: "features/knowledge/kb-content.ts" },
  { call: "POST /api/kb/gaps/:id/dismiss", file: "features/knowledge/kb-content.ts" },
  { call: "GET /api/whatsapp/webhook-config", file: "lib/whatsapp/manual-connect.ts" },
  { call: "POST /api/whatsapp/manual", file: "lib/whatsapp/manual-connect.ts" },
  { call: "POST /api/whatsapp/connections/:id/recheck", file: "lib/whatsapp/connection-actions.ts" },
  { call: "POST /api/whatsapp/connections/:id/disconnect", file: "lib/whatsapp/connection-actions.ts" },
  { call: "GET /api/calendar/google/connect", file: "features/settings/google-calendar.ts" },
  { call: "POST /api/admin/whatsapp/manual", file: "lib/whatsapp/admin-connect.ts" },
  { call: "GET /api/features", file: "features/toggles/feature-api.ts" },
  { call: "PATCH /api/features/:key", file: "features/toggles/feature-api.ts" },
  { call: "POST /api/bookings/:id/reschedule", file: "features/calendar/booking-actions.ts" },
  { call: "POST /api/bookings/:id/cancel", file: "features/calendar/booking-actions.ts" },
  { call: "POST /api/bookings/:id/complete", file: "features/calendar/booking-actions.ts" },
  { call: "POST /api/bookings/:id/no-show", file: "features/calendar/booking-actions.ts" },
  { call: "GET /api/bookings/:id/slots", file: "features/calendar/booking-actions.ts" },
  { call: "GET /api/dashboard/summary", file: "features/home/home-api.ts" },
  { call: "GET /api/billing/balance", file: "features/home/home-api.ts" },
  { call: "GET /api/billing/balance", file: "features/billing/billing-data.ts" },
  { call: "GET /api/conversations/:id/templates", file: "features/inbox/template-reply.ts" },
  // Registered behind EMBEDDED_SIGNUP_ENABLED (not_available while off). It refuses connectToken (validation_failed) until the assisted-link PR.
  { call: "POST /api/onboarding/whatsapp/embedded-signup", file: "features/connect/connect-link.ts" },
];

/**
 * Routes the Day 5 screens call that this checkout's backend does not register yet. Each is Dev 2's and only proposed in the
 * screen contracts (no branch). The screens answer "not available yet" while the API says 404, and say so in their tests, which
 * stand the route in with page.route. These are checked the other way round from FRONTEND_CALLS: the moment the backend registers one, the
 * test below fails and the line moves to FRONTEND_CALLS, so the list can't go stale and the call can't silently stay a stub.
 */
const AWAITING_BACKEND: { call: string; file: string; where: string }[] = [
  { call: "GET /api/connect-links/:token", file: "features/connect/connect-link.ts", where: "Dev 1, contract only (docs/whatsapp-connection-contract.md); not in routes.ts on main" },
];

/** Backend routes the browser never calls, and why. Anything not here and not in FRONTEND_CALLS fails the test. */
const NO_BROWSER_CALLER: Record<string, string> = {
  "GET /api/health": "infrastructure: Railway's liveness check",
  "GET /api/webhooks/whatsapp": "Meta calls it: the webhook verification handshake",
  "POST /api/webhooks/whatsapp": "Meta calls it: inbound messages and statuses (signature checked)",
  "GET /api/inngest": "Inngest calls it: introspection",
  "POST /api/inngest": "Inngest calls it: runs a function",
  "PUT /api/inngest": "Inngest calls it: syncs the function list",
  "GET /h/:token": "a staff member's browser follows the link in a WhatsApp alert; it redirects to /dashboard/inbox?chat=<id>",
  "GET /api/calendar/google/callback": "Google redirects the browser here after consent; it redirects back to Booking setup with the outcome",
  // PayU billing (Dev 2, decision 20). The Billing screen's buttons move these to FRONTEND_CALLS when they call them.
  "POST /api/billing/checkout": "not called yet: the Billing screen's Choose plan button (PayU checkout with auto-debit)",
  "POST /api/billing/topup": "not called yet: the Billing screen's top-up button (PayU one-time payment)",
  "POST /api/billing/setup-fee": "not called yet: the Billing screen's setup add-on (PayU one-time payment)",
  "GET /api/billing/payments/:id": "not called yet: the Billing screen polls it after PayU sends the payer back with ?payment=<id>",
  "POST /api/billing/payu/return": "PayU's checkout page posts the payer's browser here (a navigation); it redirects to /dashboard/billing",
  "POST /api/webhooks/payu": "PayU calls it: payment results (verified with PayU before anything changes)",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === ".next" || name === "tests" || name === "fixtures") return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const backend = parseBackendRoutes(readFileSync(ROUTES_FILE, "utf8"));

describe("the route parser", () => {
  const sample = `
    export const ROUTES = [
      { path: "/api/a", methods: { GET: a } },
      { path: "/api/b/:id", browser: true, methods: { PATCH: b, DELETE: c } },
      {
        // GET is the check; POST delivers. (prose, not routes)
        path: "/api/hook",
        methods: {
          GET: (r) => g(r),
          POST: (r) => p(r),
        },
      },
    ];`;
  it("reads each method of each entry, and ignores methods named in comments", () => {
    expect(parseBackendRoutes(sample)).toEqual(["DELETE /api/b/:id", "GET /api/a", "GET /api/hook", "PATCH /api/b/:id", "POST /api/hook"]);
  });
  it("finds the real table", () => {
    expect(backend.length).toBeGreaterThan(20);
    expect(backend).toContain("POST /api/conversations/:id/mode");
  });
});

describe("the frontend and the API agree on which routes exist", () => {
  it("every route the frontend calls is registered with that method", () => {
    const missing = FRONTEND_CALLS.map((c) => c.call).filter((call) => !backend.includes(call));
    expect(missing, "frontend calls a method and path the API does not register").toEqual([]);
  });

  it("a route the frontend is waiting for is still not registered (once it is, it moves to FRONTEND_CALLS)", () => {
    const registered = AWAITING_BACKEND.map((c) => c.call).filter((call) => backend.includes(call));
    expect(registered, "the API now registers these: move each to FRONTEND_CALLS").toEqual([]);
  });

  it("each call is made where it says, and names its path there", () => {
    for (const { call, file } of [...FRONTEND_CALLS, ...AWAITING_BACKEND]) {
      const text = readFileSync(join(FRONTEND, file), "utf8");
      const staticSegment = call.split(" ")[1].split("/").filter((s) => s && !s.startsWith(":") && s !== "api").pop()!;
      expect(text, `${file} should mention "${staticSegment}" for ${call}`).toContain(staticSegment);
    }
  });

  it("every frontend file that calls the API through lib/api/client.ts is listed above", () => {
    const listed = new Set([...FRONTEND_CALLS, ...AWAITING_BACKEND].map((c) => c.file));
    const callers = ["app", "components", "features", "lib"]
      .flatMap((d) => sourceFiles(join(FRONTEND, d)))
      .filter((path) => !path.endsWith(join("lib", "api", "client.ts")))
      .filter((path) => /from "@\/lib\/api\/client"/.test(readFileSync(path, "utf8")))
      .map((path) => relative(FRONTEND, path).split("\\").join("/"));
    expect(callers.filter((file) => !listed.has(file)), "a new file calls the API: add its routes to FRONTEND_CALLS").toEqual([]);
    expect([...listed].filter((file) => !callers.includes(file)), "a listed caller no longer uses the API client").toEqual([]);
  });

  it("every backend route is called by the frontend or has a stated reason it is not", () => {
    const called = new Set(FRONTEND_CALLS.map((c) => c.call));
    const unclassified = backend.filter((route) => !called.has(route) && !(route in NO_BROWSER_CALLER));
    expect(unclassified, "a backend route with no frontend caller and no reason: decide which it is").toEqual([]);
    const stale = Object.keys(NO_BROWSER_CALLER).filter((route) => !backend.includes(route));
    expect(stale, "listed as having no caller, but the API no longer registers it").toEqual([]);
  });
});

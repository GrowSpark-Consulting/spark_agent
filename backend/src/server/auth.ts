import type { TenantContext } from "@pakka/types";
import { createClient, isAuthRetryableFetchError, type SupabaseClient, type User } from "@supabase/supabase-js";
import { serverEnv } from "../lib/env";
import { AppError, toErrorResponse } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";
import { resolveTenant } from "../lib/tenant";
import type { RouteParams } from "./routes";

// Who is calling. The browser sends the signed-in user's Supabase access token as
// `Authorization: Bearer <token>` and, in the dashboard, the business it is working on as
// X-Pakka-Tenant. Every route that acts for a user goes through here, so the check is the same
// everywhere, and it gives the same answers the dashboard gate gives.

export const TENANT_HEADER = "x-pakka-tenant";

/** A Supabase client acting as the caller (anon key + their token), so row-level security applies. */
export type UserClientFactory = (accessToken: string) => SupabaseClient;

export const userClient: UserClientFactory = (accessToken) => {
  const env = serverEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
};

const SIGNED_OUT = "Your session has ended. Sign in again.";
// A JWT: base64url segments and dots, about 1 KB. Anything else isn't a Supabase access token.
const TOKEN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){1,4}$/;
// A tenant id. The header is only ever compared with the caller's own memberships.
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bearer token from the Authorization header, or null if there isn't a well-formed one. */
export function bearerToken(request: Request): string | null {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  return match && match[1].length <= 8192 && TOKEN.test(match[1]) ? match[1] : null;
}

export interface Caller {
  supabase: SupabaseClient;
  user: User;
}

/** Asks Supabase Auth to verify the token (a decoded token alone is not trusted). */
export async function authenticate(request: Request, makeClient: UserClientFactory = userClient): Promise<Caller> {
  const token = bearerToken(request);
  if (!token) throw new AppError("unauthenticated", SIGNED_OUT);
  const supabase = makeClient(token);
  const { data, error } = await supabase.auth.getUser(token);
  if (!error && data.user) return { supabase, user: data.user };
  if (error && (isAuthRetryableFetchError(error) || (error.status ?? 0) >= 500)) {
    throw new AppError("upstream_failed", "We couldn't check your sign-in. Try again in a moment.");
  }
  throw new AppError("unauthenticated", SIGNED_OUT);
}

/** The caller's client and business, or an AppError the route turns into a response. */
export async function requireTenant(
  request: Request,
  makeClient: UserClientFactory = userClient,
): Promise<{ supabase: SupabaseClient; context: TenantContext }> {
  const { supabase, user } = await authenticate(request, makeClient);
  const header = request.headers.get(TENANT_HEADER)?.trim() ?? "";
  const state = await resolveTenant(supabase, user, TENANT_ID.test(header) ? header : null);
  if (state.status === "no_membership") throw new AppError("no_membership", "Your account isn't linked to a business yet.");
  if (state.status === "choose") throw new AppError("forbidden", "Choose a business first.");
  return { supabase, context: state.context };
}

/** The JSON body, or a validation_failed AppError. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError("validation_failed", "Send the details as JSON.");
  }
}

/** The JSON body, or `{}` when the browser sent none (a POST whose details are all optional). */
export async function optionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("validation_failed", "Send the details as JSON.");
  }
}

/** Whether the user works for us across businesses (platform_admins, migration 0016; server only). */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new AppError("upstream_failed", "We couldn't check your access. Try again in a moment.");
  return data !== null;
}

export interface PlatformAdmin {
  user: User;
  /** Who to record in audit_logs and whatsapp_connections.connected_by: `admin:<user id>`. */
  actor: string;
}

/** The verified caller, if they are a platform admin; otherwise forbidden. X-Pakka-Tenant plays no part. */
export async function requirePlatformAdmin(request: Request, makeClient: UserClientFactory = userClient): Promise<PlatformAdmin> {
  const { user } = await authenticate(request, makeClient);
  if (!(await isPlatformAdmin(user.id))) throw new AppError("forbidden", "Only the Spark Agent team can do this.");
  return { user, actor: `admin:${user.id}` };
}

type TenantHandler<T> = (args: {
  supabase: SupabaseClient;
  context: TenantContext;
  body: unknown;
  params: RouteParams;
}) => Promise<T>;

type AdminHandler<T> = (args: { admin: PlatformAdmin; body: unknown; params: RouteParams }) => Promise<T>;

const JSON_BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

// Authorizes first, then parses the body (POST, PUT and PATCH only), runs the backend service, and turns
// any error into the `{ error: { code, message } }` envelope. The result is sent with `successStatus`;
// a service that returns nothing answers 204.
function jsonRoute<A, T>(
  authorize: (request: Request, makeClient: UserClientFactory) => Promise<A>,
  handler: (args: A & { body: unknown; params: RouteParams }) => Promise<T>,
  successStatus = 200,
) {
  return async (request: Request, makeClient: UserClientFactory = userClient, params: RouteParams = {}): Promise<Response> => {
    try {
      const authorized = await authorize(request, makeClient);
      const body = JSON_BODY_METHODS.has(request.method) ? await readJson(request) : undefined;
      const result = await handler({ ...authorized, body, params });
      return result === undefined ? new Response(null, { status: 204 }) : Response.json(result, { status: successStatus });
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return Response.json(body, { status });
    }
  };
}

/**
 * Wraps a JSON route for a member of the business: verifies the token and resolves the tenant on the
 * server (X-Pakka-Tenant only picks among the caller's own businesses). `status` defaults to 200.
 */
export function tenantRoute<T>(handler: TenantHandler<T>, options: { status?: number } = {}) {
  return jsonRoute(requireTenant, handler, options.status);
}

/**
 * Wraps a JSON route for the platform team (/api/admin/...): verifies the token and checks
 * platform_admins. The business it acts on is named in the body or path, never by X-Pakka-Tenant.
 * Same responses as tenantRoute.
 */
export function adminRoute<T>(handler: AdminHandler<T>, options: { status?: number } = {}) {
  return jsonRoute(async (request, makeClient) => ({ admin: await requirePlatformAdmin(request, makeClient) }), handler, options.status);
}

import { apiErrorFrom } from "@/lib/errors";
import { apiBaseUrl } from "@/lib/env";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

// The one way the browser calls the API (backend/, on Railway): `${NEXT_PUBLIC_API_URL}/api/...` with
// the signed-in user's Supabase access token as a bearer token, and inside the dashboard the business
// being worked on. The API verifies both; nothing here is trusted on its own.

export const TENANT_HEADER = "x-pakka-tenant";

export type ApiPath = `/api/${string}`;

export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Sent as JSON, except FormData, which the browser sends as multipart with its own boundary. */
  body?: unknown;
  /** The business from the dashboard's TenantContext. The API checks the user is a member. */
  tenantId?: string;
  signal?: AbortSignal;
  /** Send no bearer token: for the public routes (the assisted connect page), where a signed-in visitor's token must not ride along. */
  anonymous?: boolean;
}

/** The current access token, refreshed by supabase-js when it is close to expiring; null if signed out. */
async function accessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

/** Calls the API as the signed-in user and returns the raw response. Throws only if fetch fails. */
export async function apiFetch(path: ApiPath, { method, body, tenantId, signal, anonymous }: ApiRequest): Promise<Response> {
  const headers = new Headers();
  const token = anonymous ? null : await accessToken();
  // Without a token the API answers 401 unauthenticated, which the UI shows as "signed out".
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (tenantId) headers.set(TENANT_HEADER, tenantId);
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart) headers.set("content-type", "application/json");
  return fetch(`${apiBaseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
    signal,
  });
}

type CallOptions = { tenantId?: string; signal?: AbortSignal; anonymous?: boolean };

/** GETs JSON from the API; throws ApiError on an error response. */
export async function getJson<T>(path: ApiPath, options: CallOptions = {}): Promise<T> {
  const res = await apiFetch(path, { method: "GET", ...options });
  if (!res.ok) throw await apiErrorFrom(res);
  return (await res.json()) as T;
}

/** POSTs JSON to the API; throws ApiError on an error response. */
export async function postJson<T>(path: ApiPath, body: unknown, options: CallOptions = {}): Promise<T> {
  const res = await apiFetch(path, { method: "POST", body, ...options });
  if (!res.ok) throw await apiErrorFrom(res);
  return (await res.json()) as T;
}

/** PUTs JSON to the API (the webhook endpoint's save replaces it); throws ApiError on an error response. */
export async function putJson<T>(path: ApiPath, body: unknown, options: CallOptions = {}): Promise<T> {
  const res = await apiFetch(path, { method: "PUT", body, ...options });
  if (!res.ok) throw await apiErrorFrom(res);
  return (await res.json()) as T;
}

/** PATCHes JSON to the API; throws ApiError on an error response. */
export async function patchJson<T>(path: ApiPath, body: unknown, options: CallOptions = {}): Promise<T> {
  const res = await apiFetch(path, { method: "PATCH", body, ...options });
  if (!res.ok) throw await apiErrorFrom(res);
  return (await res.json()) as T;
}

/** POSTs a multipart form (a file upload); throws ApiError on an error response. */
export async function postForm<T>(path: ApiPath, form: FormData, options: CallOptions = {}): Promise<T> {
  const res = await apiFetch(path, { method: "POST", body: form, ...options });
  if (!res.ok) throw await apiErrorFrom(res);
  return (await res.json()) as T;
}

/** Calls a route that answers 204 No Content (a DELETE, or a POST with no body); throws ApiError on an error response. */
export async function sendNoContent(path: ApiPath, method: "POST" | "DELETE", options: CallOptions = {}): Promise<void> {
  const res = await apiFetch(path, { method, ...options });
  if (!res.ok) throw await apiErrorFrom(res);
}

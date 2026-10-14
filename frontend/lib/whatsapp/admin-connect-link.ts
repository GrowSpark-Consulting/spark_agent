import { z } from "zod";
import { apiFetch } from "@/lib/api/client";
import { apiErrorFrom, formatError } from "@/lib/errors";

// The admin's side of the assisted connect link: POST /api/admin/whatsapp/connect-link { tenantId } → 201 { url, expiresAt }
// (backend/src/channels/whatsapp/connect/connect-link.ts, docs/whatsapp-connection-contract.md). Platform admins only: the server answers
// `forbidden` to anyone else, and that is the only check that counts. The link is valid 24 hours and works once. The URL carries the raw
// token, which the server never stores: it exists in this one answer. So this file only ever returns it to the form that asked, and the
// form keeps it in memory only: a refresh, or leaving the page, loses it and a new link has to be made on purpose.

const Answer = z.object({
  url: z.url().refine((u) => /^https?:\/\/[^/]+\/connect\/[A-Za-z0-9_-]{43}$/.test(u), "not a connect link"),
  expiresAt: z.iso.datetime(),
});

export type ConnectLinkResult =
  | { state: "done"; url: string; expiresAt: string }
  | { state: "rejected"; code: string; message: string; fields: Record<string, string>; retryable: boolean };

/** What can be checked before anything is sent. The server validates again and decides. */
export function validateLinkTenant(tenantId: string): string | null {
  if (tenantId.trim() === "") return "Enter the business's ID.";
  if (!z.guid().safeParse(tenantId.trim()).success) return "That isn't a business ID. It looks like 10000000-0000-0000-0000-000000000004.";
  return null;
}

/** The words for the refusals the contract names; the server's own message for the rest. */
function wording(code: string, message: string): string {
  if (code === "not_available") return "Connect links aren't switched on yet (the server has Embedded Signup off). Nothing was made.";
  if (code === "not_found") return "We couldn't find that business. Check the ID. Nothing was made.";
  if (code === "forbidden") return "Only the Spark Agent team can make connect links. Nothing was made.";
  return message;
}

/** POST /api/admin/whatsapp/connect-link. One request per call; a failure is never retried here, because a retry could make a second live link. */
export async function createConnectLink(tenantId: string, signal?: AbortSignal): Promise<ConnectLinkResult> {
  const problem = validateLinkTenant(tenantId);
  if (problem) return { state: "rejected", code: "validation_failed", message: problem, fields: { tenantId: problem }, retryable: false };
  try {
    const res = await apiFetch("/api/admin/whatsapp/connect-link", { method: "POST", body: { tenantId: tenantId.trim() }, signal });
    if (!res.ok) {
      const shown = formatError(await apiErrorFrom(res));
      return { state: "rejected", code: shown.code, message: wording(shown.code, shown.message), fields: shown.fields ?? {}, retryable: shown.retryable };
    }
    const parsed = Answer.safeParse(await res.json().catch(() => null));
    // A link may exist on the server even though this answer is unusable; say so rather than claim nothing was made.
    if (!parsed.success) {
      return { state: "rejected", code: "internal", message: "The server answered, but not with a link we can read. A link may have been made that cannot be shown again; make a new one.", fields: {}, retryable: false };
    }
    return { state: "done", ...parsed.data };
  } catch (err) {
    const shown = formatError(err);
    return { state: "rejected", code: shown.code, message: shown.message, fields: {}, retryable: shown.retryable };
  }
}

/** "Valid until 15 Oct, 4:30 pm. It works once." in the viewer's own time zone. */
export function expiryLabel(expiresAt: string, now: Date = new Date()): string {
  const at = new Date(expiresAt);
  if (at.getTime() <= now.getTime()) return "This link has already expired.";
  return `Valid until ${at.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}. It works once.`;
}

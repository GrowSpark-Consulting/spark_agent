import { AdminConnection, type ConnectionMethod, type ConnectionStatus } from "@pakka/types";
import { z } from "zod";
import { getJson } from "@/lib/api/client";
import { AdminDataError } from "@/lib/admin/billing";
import { overallSummary } from "@/lib/whatsapp/last-check";

// The admin panel's connection list (docs/contracts.md, "Admin panel"; backend/src/admin/connections.ts). Read only.
//   GET /api/admin/whatsapp/connections   → AdminConnection[]: a plain array (no paging), newest first, at most 500
// Platform admins only: the server answers `forbidden` to anyone else and that is the only check that counts. The route names no business,
// so no call here sends X-Pakka-Tenant. No token or secret is in the answer, and none is read here.

export async function fetchAdminConnections(signal?: AbortSignal): Promise<AdminConnection[]> {
  const parsed = z.array(AdminConnection).safeParse(await getJson<unknown>("/api/admin/whatsapp/connections", { signal }));
  if (!parsed.success) throw new AdminDataError("connection list");
  return parsed.data;
}

/** The server returns at most this many; a list this long may be cut short, and the screen says so. */
export const ADMIN_CONNECTIONS_CAP = 500;

export const METHOD_LABEL: Record<ConnectionMethod, string> = {
  embedded_signup: "Facebook sign-up",
  assisted: "Assisted setup",
  manual_byo: "Connected by hand",
  platform: "Spark Agent platform number",
};

/** What each status means for the business, in the team's words (the owner's own screen words it for the owner). */
export const STATUS_VIEW: Record<ConnectionStatus, { label: string; tone: "ok" | "warn" | "off"; detail: string }> = {
  active: { label: "Connected", tone: "ok", detail: "Sending and receiving." },
  pending: { label: "Connecting", tone: "warn", detail: "Setup with Meta isn't finished; nothing is sent yet." },
  validating: { label: "Checking", tone: "warn", detail: "The connection checks are running; nothing is sent until they pass." },
  failed: { label: "Failed", tone: "warn", detail: "A check failed, so no messages are sent from this number." },
  disconnected: { label: "Disconnected", tone: "off", detail: "No longer sends or receives through Spark Agent." },
};

export const isPlatformNumber = (c: Pick<AdminConnection, "method">) => c.method === "platform";

const WHEN = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/** A date and time in IST, or "—" for a missing or unreadable one. */
export function whenText(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : WHEN.format(date);
}

/** The business's name, or a plain stand-in when the connection's business could not be read (the server sends ""). */
export const businessName = (c: Pick<AdminConnection, "tenantName">) => c.tenantName.trim() || "Unnamed business";

/** One line for the last check, claiming only what its `overall` proves; a connection never checked (or stored in an older shape) says so. */
export function lastCheckLine(c: Pick<AdminConnection, "lastCheck">): string {
  if (!c.lastCheck) return "Not checked yet, or the stored result is in an older format.";
  if (c.lastCheck.checks.length === 0) return "Checked, but no results were stored.";
  return overallSummary(c.lastCheck.overall, c.lastCheck.checks.length);
}

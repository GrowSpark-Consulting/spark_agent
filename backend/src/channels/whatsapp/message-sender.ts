import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { OutsideWindowError, registerSender, SendError, type MessageSender, type SenderFactory } from "../../notify/sender";
import { sendInteractive, sendTemplate, sendText, type AdapterDeps, type AdapterError, type AdapterResult, type SendConnection } from "./adapter";

// How notify.send reaches WhatsApp (module 1). The factory registered at startup loads one business's
// connection with the service role and returns a MessageSender bound to it. The token stays encrypted
// here; the adapter decrypts it for each call. An adapter failure is thrown as a SendError with the
// shared code, so notify.send can tell outside_window, rate_limited or a broken token apart.

const NOT_CONNECTED = "This business has no connected WhatsApp number, so the message was not sent.";

const ConnectionRow = z.object({ tenant_id: z.string(), method: z.string(), phone_number_id: z.string(), token_enc: z.string(), status: z.string() });

/**
 * The phone number id and encrypted token of one active connection, read with the service role (whatsapp_connections
 * is closed to every other role): the business's own, or one of our platform numbers (the shared demo number a trial
 * is routed through, which notify_target picks for a chat on its channel; 0030). The returned tenantId is the
 * connection's own business, since the adapter decrypts the token with it. A missing or inactive connection, or another
 * business's own number, is whatsapp_not_connected; a database failure is thrown as a plain Error.
 */
export async function loadSendConnection(
  db: SupabaseClient,
  ids: { tenantId: string; connectionId: string },
): Promise<SendConnection> {
  const { data, error } = await db
    .from("whatsapp_connections")
    .select("tenant_id, method, phone_number_id, token_enc, status")
    .eq("id", ids.connectionId)
    .limit(1);
  if (error) throw new Error(`loading the WhatsApp connection failed: ${error.message}`);
  const [row] = z.array(ConnectionRow).max(1).parse(data);
  const usable = row && row.status === "active" && (row.tenant_id === ids.tenantId || row.method === "platform");
  if (!row || !usable) throw new SendError("whatsapp_not_connected", NOT_CONNECTED);
  return { tenantId: row.tenant_id, connectionId: ids.connectionId, phoneNumberId: row.phone_number_id, tokenEnc: row.token_enc };
}

/** The adapter's failure as notify.send expects it: OutsideWindowError for Meta's 131047, otherwise a SendError. */
function toSendError(error: AdapterError): SendError {
  if (error.code === "outside_window") return new OutsideWindowError(error.message);
  return new SendError(error.code, error.message, { retryable: error.retryable, outcomeUnknown: error.outcomeUnknown });
}

function unwrap<T>(result: AdapterResult<T>): T {
  if (result.ok) return result.value;
  throw toSendError(result.error);
}

/** A MessageSender bound to one loaded connection. */
export function whatsAppSender(connection: SendConnection, deps: AdapterDeps = {}): MessageSender {
  return {
    sendText: async (to, text) => unwrap(await sendText(connection, to, text, deps)),
    sendTemplate: async (to, name, language, params, buttons) =>
      unwrap(await sendTemplate(connection, to, { name, language, params, ...(buttons?.length ? { buttons } : {}) }, deps)),
    sendInteractive: async (to, message) => unwrap(await sendInteractive(connection, to, message, deps)),
  };
}

/** The factory notify.send uses: it loads the connection for each send. `deps` lets tests pass fetch and env. */
export function whatsAppSenderFactory(deps: AdapterDeps = {}): SenderFactory {
  return async (ids) => whatsAppSender(await loadSendConnection(supabaseAdmin(), ids), deps);
}

/** Called once at startup (server/main.ts): from then on notify.send sends through WhatsApp. */
export function registerWhatsAppSender(): void {
  registerSender(whatsAppSenderFactory());
}

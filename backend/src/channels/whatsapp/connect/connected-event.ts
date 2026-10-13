// `whatsapp/connected` (docs/contracts.md, section 5): a business's WhatsApp number is connected and active. Sent by every connection path (manual, Embedded Signup,
// assisted) once, after the connection is saved with status `active`. Ids only: no phone number, token or secret. The event id holds the time of the checks that
// made the connection, so a later reconnection of the same row is a new event and a repeat of the same one is dropped by Inngest. Best effort: a failure to send
// is logged with a fixed line and never fails or undoes the connection. No function listens for it yet (template submission waits for Dev 2's template-status table).

export type ConnectedEvent = { name: "whatsapp/connected"; id: string; data: { tenantId: string; connectionId: string } };
export type SendConnectedEvent = (event: ConnectedEvent) => Promise<unknown>;

/** The longest the connect waits for Inngest. The connection is already saved: a slow Inngest must not hold the answer (or the test message check) back. */
export const SEND_TIMEOUT_MS = 3000;

/** Sends the event for a saved, active connection. Never throws; does nothing when there is no sender. */
export async function sendConnectedEvent(send: SendConnectedEvent | undefined, connection: { id: string; tenant_id: string }, ranAt: string): Promise<void> {
  if (!send) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sending = send({ name: "whatsapp/connected", id: `whatsapp_connected:${connection.id}:${ranAt}`, data: { tenantId: connection.tenant_id, connectionId: connection.id } });
    sending.catch(() => undefined); // a send that fails after the wait is over is not an unhandled rejection
    await Promise.race([sending, new Promise((_resolve, reject) => (timer = setTimeout(() => reject(new Error("timeout")), SEND_TIMEOUT_MS)))]);
  } catch {
    console.error("[whatsapp-connect] the connected event could not be sent");
  } finally {
    clearTimeout(timer);
  }
}

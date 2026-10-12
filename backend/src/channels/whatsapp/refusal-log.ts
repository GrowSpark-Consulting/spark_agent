// Why the webhook refused a request (POST /api/webhooks/whatsapp answers 401). The answer to Meta stays the same for every reason; this line is only
// for us. It carries a fixed reason code and counts, never a secret, a phone number, an id or any text from the request. Each reason writes at most
// one line per window, and the next line says how many were held back, so a scanner hitting the route cannot flood the logs.

export type RefusalReason = "no_signature_header" | "bad_signature_format" | "body_not_json" | "no_byo_connection" | "byo_signature_mismatch";

export type RefusalCounts = {
  /** Distinct phone number ids the (not yet trusted) body named. */
  phoneIds?: number;
  /** manual_byo connections found for those ids. */
  byoRows?: number;
  /** Of those, how many had a saved secret that could not be decrypted. */
  byoUndecryptable?: number;
};

export type RefusalLogOptions = { now?: () => number; windowMs?: number; write?: (line: string) => void };

export type RefusalLog = ReturnType<typeof createRefusalLog>;

export function createRefusalLog({ now = Date.now, windowMs = 60_000, write = (line) => console.warn(line) }: RefusalLogOptions = {}) {
  const state = new Map<RefusalReason, { lastWritten: number; suppressed: number }>();
  return {
    refused(reason: RefusalReason, counts: RefusalCounts = {}): void {
      const at = now();
      const entry = state.get(reason);
      if (entry && at - entry.lastWritten < windowMs) {
        entry.suppressed++;
        return;
      }
      state.set(reason, { lastWritten: at, suppressed: 0 });
      write(
        `[whatsapp-webhook] refused reason=${reason} phone_ids=${counts.phoneIds ?? 0} byo_rows=${counts.byoRows ?? 0} byo_undecryptable=${counts.byoUndecryptable ?? 0} suppressed=${entry?.suppressed ?? 0}`,
      );
    },
  };
}

/** The one the webhook handler uses. */
export const refusalLog = createRefusalLog();

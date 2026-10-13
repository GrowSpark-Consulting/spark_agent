import { runGraphChecks, type Graph, type LastCheck } from "./checks";
import type { MetaProbe } from "./manual";

// Asking Meta about one connection and running the five Graph checks on its answers: what a recheck (recheck.ts) and the daily
// health job (health.ts) both do. The caller decides what to do with the result (the status, what to save, who to tell): nothing
// here writes to the database or sends a message.

export interface RunChecksDeps {
  probe: (args: { wabaId: string; phoneNumberId: string; token: string }) => Promise<MetaProbe>;
  graph: Graph;
  /** Whether a signed webhook from the connection's own app has arrived (webhook-seen.ts). */
  webhookSeen: (tenantId: string, connectionId: string) => Promise<boolean>;
  now: () => Date;
}

export type ChecksRun =
  /** Meta could not be asked (5xx, 429, no answer): nothing is known. */
  | { state: "unreachable" }
  | {
      state: "done";
      probe: Exclude<MetaProbe, { state: "unreachable" }>;
      lastCheck: LastCheck;
      /** What Meta says about the number, ready to save; a field Meta did not give is absent. */
      fresh: Record<string, string>;
      /** An app is subscribed to the account after the webhook check (null: Meta was not asked or did not say). */
      subscribed: boolean | null;
      /** What the webhook proof read said while the checks ran (undefined: it was not read). */
      seenBefore: boolean | undefined;
      /** When the token runs out; null: never; undefined: Meta did not say. */
      tokenExpiresAt: Date | null | undefined;
    };

export async function runConnectionChecks(
  args: { tenantId: string; connectionId: string; method: string; wabaId: string; phoneNumberId: string; token: string; allowSubscribe?: boolean; coexistence?: boolean },
  deps: RunChecksDeps,
): Promise<ChecksRun> {
  const probe = await deps.probe({ wabaId: args.wabaId, phoneNumberId: args.phoneNumberId, token: args.token });
  if (probe.state === "unreachable") return { state: "unreachable" };

  let subscribed: boolean | null = null;
  let seenBefore: boolean | undefined;
  let tokenExpiresAt: Date | null | undefined;
  const accepted = probe.state === "ok";
  const lastCheck = await runGraphChecks(
    {
      wabaId: args.wabaId,
      token: args.token,
      method: args.method,
      accepted,
      tokenExpired: probe.state === "rejected" && probe.reason === "token_expired",
      onSubscribed: (value) => {
        subscribed = value;
      },
      onTokenExpiry: (value) => {
        tokenExpiresAt = value;
      },
      ...(args.allowSubscribe === false ? { allowSubscribe: false } : {}),
      ...(args.coexistence === true ? { coexistence: true } : {}),
      inAccount: probe.state === "ok" && probe.numberInAccount,
      facts: { nameStatus: probe.state === "ok" ? (probe.info.facts?.nameStatus ?? null) : null, platformType: probe.state === "ok" ? (probe.info.facts?.platformType ?? null) : null },
      webhookSeen: async () => (seenBefore = await deps.webhookSeen(args.tenantId, args.connectionId)),
    },
    deps.graph,
    deps.now(),
  );

  const fresh: Record<string, string> = {};
  if (probe.state === "ok") {
    if (probe.info.displayPhone) fresh.display_phone = probe.info.displayPhone;
    if (probe.info.verifiedName) fresh.verified_name = probe.info.verifiedName;
    if (probe.info.qualityRating) fresh.quality_rating = probe.info.qualityRating;
  }
  return { state: "done", probe, lastCheck, fresh, subscribed, seenBefore, tokenExpiresAt };
}

import { retrieveKb } from "../../kb/retrieve";
import { inngest } from "../../inngest/client";
import { isEnabled } from "../../features/is-enabled";
import { writeAudit } from "../../lib/audit";
import { serverEnv } from "../../lib/env";
import { send } from "../../notify/send";
import { llm } from "../llm";
import type { PackSource } from "../packs/load";
import { createDbPackSource } from "../packs/store";
import { createSchedulingDeps } from "../scheduling/port-db";
import { createCatalogLoader } from "../scoring/catalog-db";
import { createSystemNoticePort } from "./ports";
import type { ReplyDeps } from "./reply";
import type { PipelineStore } from "./store";
import type { UnderstandDeps } from "./understand";

// The real dependencies of the pipeline's understanding step, for the Inngest function (inngest/process-message.ts).

const MAX_CACHED_PACKS = 200;

/**
 * A pack's definition by key and version, read once per process: a published version never changes
 * (agent/packs/sync.ts refuses an edit), so there is nothing to go stale. A pack that is missing, or a read that
 * failed, is not remembered. The business's own overrides are not cached: they are read on every turn.
 */
export function cachedPackLoader(source: Pick<PackSource, "get">): UnderstandDeps["loadPackDefinition"] {
  const cache = new Map<string, unknown>();
  return async (key, version) => {
    const id = `${key}@${version}`;
    if (cache.has(id)) return cache.get(id) as unknown;
    const definition = await source.get(key, version);
    if (definition === null || definition === undefined) return null;
    if (cache.size >= MAX_CACHED_PACKS) cache.delete(cache.keys().next().value as string); // the oldest
    // Shared by every turn of the process: frozen, so no turn can change what another one reads.
    const shared = deepFreeze(definition);
    cache.set(id, shared);
    return shared;
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const scheduling = createSchedulingDeps();

/** The real dependencies of the reply step: notify.send (including the system notice), the audit and the queue. Owners are alerted by the handoff-alert job, not here. */
export function replyDeps(store: PipelineStore): ReplyDeps {
  return {
    store,
    llm: llm(),
    send: (tenantId, kind, payload) => send(tenantId, kind, payload),
    audit: writeAudit,
    sendEvent: (event) => inngest.send(event),
    systemNotice: createSystemNoticePort((tenantId, kind, payload) => send(tenantId, kind, payload)),
    privacyPolicyUrl: serverEnv().PRIVACY_POLICY_URL,
    // Booking (step 6): Dev 2's booking functions, used only when the business has the booking feature on.
    scheduling,
  };
}

let packLoader: UnderstandDeps["loadPackDefinition"] | undefined;
const loadCatalog = createCatalogLoader();

export function understandDeps(store: PipelineStore, signal?: AbortSignal): UnderstandDeps {
  packLoader ??= cachedPackLoader(createDbPackSource());
  return {
    store,
    llm: llm(),
    loadPackDefinition: packLoader,
    retrieve: (tenantId, query) => retrieveKb(tenantId, query),
    signal,
    // Qualifying (step 5): the lead is scored against the business's catalog when its plan has lead_qualification.
    scoring: { loadCatalog, isEnabled },
  };
}

import type { FeatureKey } from "../billing/credit-costs";
import { supabaseAdmin } from "../lib/supabase-admin";

// isEnabled (docs/handover.md, module 7): the tenant is live (active, or in a trial that has not
// ended), its plan includes the feature, and its toggle is on (features.default_on when the tenant
// never set it). States are cached for 60 seconds per server instance; the features and plans
// catalogue is shared across tenants.

export type FeatureState = {
  key: string;
  inPlan: boolean; // the tenant's plan lists the feature
  toggledOn: boolean; // tenant_features.enabled, or features.default_on when unset
  enabled: boolean; // tenant live && inPlan && toggledOn
};

type Catalogue = { defaults: Map<string, boolean>; planFeatures: Map<string, Set<string>> };

const TTL_MS = 60_000;
const MAX_CACHED_TENANTS = 5_000;

const cache = new Map<string, { loadedAt: number; states: FeatureState[] }>();
const inFlight = new Map<string, Promise<FeatureState[]>>();
const generation = new Map<string, number>(); // bumped on invalidation; stale loads are not cached
let catalogueCache: { loadedAt: number; value: Promise<Catalogue> } | undefined;

export async function isEnabled(tenantId: string, featureKey: FeatureKey): Promise<boolean> {
  const states = await getFeatureStates(tenantId);
  return states.find((s) => s.key === featureKey)?.enabled ?? false;
}

/**
 * The business's own switch for a feature (tenant_features, else features.default_on), whatever its plan or status: for
 * notices about the account, which go even to a paused business (notify KINDS `preference`).
 */
export async function isSwitchedOn(tenantId: string, featureKey: FeatureKey): Promise<boolean> {
  const states = await getFeatureStates(tenantId);
  return states.find((s) => s.key === featureKey)?.toggledOn ?? false;
}

/**
 * Every feature with its plan and toggle state. Pass `fresh: true` where a user just changed a
 * toggle (the toggles screen): other server instances may still hold the old state for up to 60 s.
 */
export async function getFeatureStates(tenantId: string, options: { fresh?: boolean } = {}): Promise<FeatureState[]> {
  if (options.fresh) return loadFeatureStates(tenantId);
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit.states;
  const pending = inFlight.get(tenantId);
  if (pending) return pending;

  const startedAt = generation.get(tenantId) ?? 0;
  const load = loadFeatureStates(tenantId)
    .then((states) => {
      if ((generation.get(tenantId) ?? 0) === startedAt) remember(tenantId, states);
      return states;
    })
    .finally(() => {
      if (inFlight.get(tenantId) === load) inFlight.delete(tenantId);
    });
  inFlight.set(tenantId, load);
  return load;
}

/** Call after a toggle or plan change so this instance stops serving the old state. */
export function invalidateFeatureCache(tenantId?: string): void {
  const tenants = tenantId ? [tenantId] : [...new Set([...cache.keys(), ...inFlight.keys()])];
  for (const t of tenants) {
    generation.set(t, (generation.get(t) ?? 0) + 1);
    cache.delete(t);
    inFlight.delete(t);
  }
  if (!tenantId) catalogueCache = undefined;
}

function remember(tenantId: string, states: FeatureState[]): void {
  if (cache.size >= MAX_CACHED_TENANTS) {
    const now = Date.now();
    for (const [t, entry] of cache) if (now - entry.loadedAt >= TTL_MS) cache.delete(t);
    const oldest = cache.keys().next().value;
    if (cache.size >= MAX_CACHED_TENANTS && oldest !== undefined) cache.delete(oldest);
  }
  cache.set(tenantId, { loadedAt: Date.now(), states });
}

function catalogue(): Promise<Catalogue> {
  if (catalogueCache && Date.now() - catalogueCache.loadedAt < TTL_MS) return catalogueCache.value;
  const value = loadCatalogue();
  catalogueCache = { loadedAt: Date.now(), value };
  value.catch(() => {
    if (catalogueCache?.value === value) catalogueCache = undefined;
  });
  return value;
}

async function loadCatalogue(): Promise<Catalogue> {
  const db = supabaseAdmin();
  const [features, plans] = await Promise.all([
    db.from("features").select("key, default_on"),
    db.from("plans").select("key, feature_keys"),
  ]);
  if (features.error) throw new Error(`feature states: ${features.error.message}`);
  if (plans.error) throw new Error(`feature states: ${plans.error.message}`);
  return {
    defaults: new Map((features.data ?? []).map((f) => [f.key as string, f.default_on as boolean])),
    planFeatures: new Map((plans.data ?? []).map((p) => [p.key as string, new Set<string>(p.feature_keys ?? [])])),
  };
}

async function loadFeatureStates(tenantId: string): Promise<FeatureState[]> {
  const db = supabaseAdmin();
  const [cat, tenant, toggles] = await Promise.all([
    catalogue(),
    db.from("tenants").select("plan_key, status, trial_ends_at").eq("id", tenantId).maybeSingle(),
    db.from("tenant_features").select("feature_key, enabled").eq("tenant_id", tenantId),
  ]);
  if (tenant.error) throw new Error(`feature states: ${tenant.error.message}`);
  if (toggles.error) throw new Error(`feature states: ${toggles.error.message}`);

  const live = tenant.data ? isLive(tenant.data.status, tenant.data.trial_ends_at) : false;
  const planKeys = (tenant.data && cat.planFeatures.get(tenant.data.plan_key)) || new Set<string>();
  const toggled = new Map<string, boolean>((toggles.data ?? []).map((t) => [t.feature_key, t.enabled]));
  return [...cat.defaults].map(([key, defaultOn]) => {
    const inPlan = planKeys.has(key);
    const toggledOn = toggled.get(key) ?? defaultOn;
    return { key, inPlan, toggledOn, enabled: live && inPlan && toggledOn };
  });
}

// Paused and cancelled businesses send nothing automated; neither does a trial past its end date,
// even if the trial-lifecycle job has not paused it yet.
function isLive(status: string, trialEndsAt: string | null): boolean {
  if (status === "active") return true;
  if (status !== "trial") return false;
  return trialEndsAt === null || Date.parse(trialEndsAt) > Date.now();
}

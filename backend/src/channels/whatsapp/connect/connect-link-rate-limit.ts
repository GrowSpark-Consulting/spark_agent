// A small per-caller limit for the two public connect-link routes (docs/whatsapp-connection-contract.md, open decision 2): 30 requests a minute from one
// address. In memory and per process, which is enough here: a link token is 256 random bits and cannot be guessed, so this only keeps a caller from loading
// the database. A restart or a second instance resets it.

export interface RateLimiter {
  (key: string): boolean;
  /** How many callers are remembered (for tests). */
  size(): number;
  /** Forgets every caller (for tests). */
  reset(): void;
}

export function createRateLimiter(options: { limit: number; windowMs: number; now?: () => number; maxKeys?: number }): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastPrune = 0;

  const prune = (at: number) => {
    for (const [key, entry] of hits) if (entry.resetAt <= at) hits.delete(key);
    // Still too many live callers: drop the oldest, so memory stays bounded whatever arrives.
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next();
      if (oldest.done) break;
      hits.delete(oldest.value);
    }
  };

  const allow = ((key: string) => {
    const at = now();
    // Full: sweep, but at most once a second, so a flood of new addresses cannot make every request scan the whole map.
    if (hits.size >= maxKeys && at - lastPrune >= 1000) {
      lastPrune = at;
      prune(at);
    }
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= at) {
      hits.set(key, { count: 1, resetAt: at + options.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= options.limit;
  }) as RateLimiter;
  allow.size = () => hits.size;
  allow.reset = () => hits.clear();
  return allow;
}

/**
 * Who is calling: the last address of `x-forwarded-for`, which is the one our own proxy appended (the ones before it are whatever the caller wrote).
 * "unknown" when there is no header, so such callers share one limit.
 */
export function clientKey(request: Request): string {
  const header = request.headers.get("x-forwarded-for");
  const last = header?.split(",").pop()?.trim();
  return last ? last.slice(0, 64) : "unknown";
}

/** The limit the public routes share: 30 a minute per address. */
export const connectLinkLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

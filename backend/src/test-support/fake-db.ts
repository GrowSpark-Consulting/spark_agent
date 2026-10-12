import type { SupabaseClient } from "@supabase/supabase-js";

export interface FakeDbResponse {
  data: unknown;
  error: { code?: string; message: string } | null;
  /** For a query made with `{ count: "exact" }`. */
  count?: number | null;
}

const METHODS = [
  "select", "insert", "update", "upsert", "delete", "eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "not", "order", "limit", "returns",
  "single", "maybeSingle",
];

/**
 * A stand-in for the Supabase query builder for the jobs' tests: every chained call records itself, and each query
 * on a table resolves to that table's next canned response (a list is answered in order, the last one repeating).
 * `rpc(name, args)` is answered from `rpc:<name>` the same way and recorded with the table `rpc:<name>`.
 */
export function fakeDb(responses: Record<string, FakeDbResponse | FakeDbResponse[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const served: Record<string, number> = {};
  const next = (name: string): FakeDbResponse => {
    const canned = responses[name];
    const index = served[name] ?? 0;
    served[name] = index + 1;
    return Array.isArray(canned)
      ? canned[Math.min(index, canned.length - 1)]
      : (canned ?? { data: null, error: { code: "PGRST205", message: `no fake for ${name}` } });
  };
  const builderFor = (table: string, response: FakeDbResponse) => {
    const builder: Record<string, unknown> = {};
    for (const method of METHODS) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return builder;
      };
    }
    builder.then = (resolve: (v: FakeDbResponse) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(response).then(resolve, reject);
    return builder;
  };
  const client = {
    from(table: string) {
      return builderFor(table, next(table));
    },
    rpc(name: string, args?: unknown) {
      calls.push({ table: `rpc:${name}`, method: "rpc", args: [args] });
      return builderFor(`rpc:${name}`, next(`rpc:${name}`));
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

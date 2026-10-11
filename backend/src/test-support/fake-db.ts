import type { SupabaseClient } from "@supabase/supabase-js";

export interface FakeDbResponse {
  data: unknown;
  error: { code?: string; message: string } | null;
}

const METHODS = ["select", "insert", "update", "eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "not", "order", "limit", "returns"];

/**
 * A stand-in for the Supabase query builder for the jobs' tests: every chained call records itself, and each query
 * on a table resolves to that table's next canned response (a list is answered in order, the last one repeating).
 */
export function fakeDb(responses: Record<string, FakeDbResponse | FakeDbResponse[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const served: Record<string, number> = {};
  const client = {
    from(table: string) {
      const canned = responses[table];
      const index = served[table] ?? 0;
      served[table] = index + 1;
      const response = Array.isArray(canned)
        ? canned[Math.min(index, canned.length - 1)]
        : (canned ?? { data: null, error: { code: "PGRST205", message: `no fake for ${table}` } });
      const builder: Record<string, unknown> = {};
      for (const method of METHODS) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return builder;
        };
      }
      builder.then = (resolve: (v: FakeDbResponse) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(response).then(resolve, reject);
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

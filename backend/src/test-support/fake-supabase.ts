import type { SupabaseClient } from "@supabase/supabase-js";

export interface FakeResponse {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/**
 * A minimal stand-in for the Supabase query builder: every chained call records itself and the
 * chain resolves to the canned response for its table. Enough for the services' read queries.
 * A table given a list of responses answers its queries in that order, the last one repeating.
 */
export function fakeSupabase(responses: Record<string, FakeResponse | FakeResponse[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const served: Record<string, number> = {};
  const client = {
    from(table: string) {
      const canned = responses[table];
      const index = served[table] ?? 0;
      served[table] = index + 1;
      const response = Array.isArray(canned)
        ? canned[Math.min(index, canned.length - 1)]
        : (canned ?? { data: null, error: { code: "PGRST205", message: "missing" } });
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "update", "eq", "gt", "in", "not", "order", "limit", "returns"]) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return builder;
        };
      }
      builder.then = (resolve: (v: FakeResponse) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(response).then(resolve, reject);
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

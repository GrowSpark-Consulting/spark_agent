import type { SupabaseClient } from "@supabase/supabase-js";

// A fake service-role database for the Agent settings route (agent/settings/agent-settings.ts): tenants, services and audit_logs. Like fake-tables it
// applies the filters a query makes (so a query that forgets its business reads another's rows) and records every call. Unlike it, a filter on the
// jsonb column `agent_settings` compares JSON by value whatever the key order, as Postgres does for jsonb: that is what the route's compare-and-set
// relies on (checked against a real local database on 15 Oct: a stale value updates nothing, key order does not matter).

export type Row = Record<string, unknown>;
export interface SettingsCall {
  table: string;
  op: "select" | "update" | "insert";
  payload?: unknown;
  filters: { column: string; value: unknown }[];
}
export type Failure = "error" | "throw";
export interface SettingsDbHooks {
  /** Called just before the nth update of `tenants` is applied: a place for "someone else changes it now". */
  beforeTenantUpdate?: (n: number, tables: Record<string, Row[]>) => void;
  /** Makes a call fail: "error" is the database saying no, "throw" a dropped connection. */
  fail?: (call: { table: string; op: string }) => Failure | undefined;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export function fakeSettingsDb(initial: { tenants: Row[]; services?: Row[]; audit_logs?: Row[] }, hooks: SettingsDbHooks = {}) {
  const tables: Record<string, Row[]> = { tenants: initial.tenants, services: initial.services ?? [], audit_logs: initial.audit_logs ?? [] };
  const calls: SettingsCall[] = [];
  let tenantUpdates = 0;

  const matches = (row: Row, filters: SettingsCall["filters"]) =>
    filters.every((f) => {
      const stored = row[f.column];
      if (f.column === "agent_settings" && typeof f.value === "string") {
        try {
          return canonical(stored) === canonical(JSON.parse(f.value));
        } catch {
          return false;
        }
      }
      return stored === f.value;
    });

  const run = (call: SettingsCall): { data: Row[] | null; error: { code?: string } | null } => {
    const rows = (tables[call.table] ??= []);
    if (call.op === "insert") {
      const added = (Array.isArray(call.payload) ? call.payload : [call.payload]) as Row[];
      rows.push(...added.map((r, i) => ({ id: `generated-${rows.length + i}`, ...r })));
      return { data: added, error: null };
    }
    if (call.op === "update") {
      if (call.table === "tenants") hooks.beforeTenantUpdate?.(++tenantUpdates, tables);
      const hit = rows.filter((r) => matches(r, call.filters));
      for (const row of hit) Object.assign(row, structuredClone(call.payload as Row));
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    }
    return { data: rows.filter((r) => matches(r, call.filters)).map((r) => structuredClone(r)), error: null };
  };

  const db = {
    from(table: string) {
      const call: SettingsCall = { table, op: "select", filters: [] };
      calls.push(call);
      let limit: number | undefined;
      const result = () => {
        const failure = hooks.fail?.({ table, op: call.op });
        if (failure === "throw") throw new Error("connection reset");
        if (failure === "error") return { data: null, error: { code: "XX001" } };
        const out = run(call);
        return limit !== undefined && out.data ? { ...out, data: out.data.slice(0, limit) } : out;
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (payload: unknown) => ((call.op = "update"), (call.payload = payload), builder),
        insert: (payload: unknown) => ((call.op = "insert"), (call.payload = payload), builder),
        eq: (column: string, value: unknown) => (call.filters.push({ column, value }), builder),
        limit: (n: number) => ((limit = n), builder),
        then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => {
          try {
            return resolve(result());
          } catch (error) {
            return reject ? reject(error) : Promise.reject(error);
          }
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;

  return { db, calls, tables };
}

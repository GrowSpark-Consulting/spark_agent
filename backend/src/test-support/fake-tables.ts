import type { SupabaseClient } from "@supabase/supabase-js";

// A fake Supabase client for code that reads, and for simple inserts and updates: every query names a table, and the fake answers with the rows the
// test gave for that table, after applying the filters the query made (eq, is null, in, not in, gt/lt on strings), ordering and limit. An insert adds
// the row (refusing a repeat of a `unique` column the way Postgres does, code 23505) and an update changes the rows the filters pick. It records every
// call, so a test can check that every query names the business. It is not a database: it exists so that a module's own logic and its filters are
// tested without one.

export type Row = Record<string, unknown>;
export interface Recorded {
  table: string;
  op: "select" | "update" | "insert";
  select: string;
  payload?: unknown;
  filters: { column: string; op: string; value: unknown }[];
  order?: { column: string; ascending: boolean };
  limit?: number;
}
type Failure = { error: { code?: string; message?: string } };
export interface FakeTablesOptions {
  /** Columns that must be unique, by table: an insert that repeats one fails with 23505. */
  unique?: Record<string, string>;
}

export function fakeTables(tables: Record<string, Row[] | Failure>, options: FakeTablesOptions = {}) {
  const calls: Recorded[] = [];
  let counter = 0;

  const matching = (record: Recorded, source: Row[]): Row[] => {
    let rows = [...source];
    for (const f of record.filters) {
      rows = rows.filter((row) => {
        const v = row[f.column];
        switch (f.op) {
          case "eq":
            return v === f.value;
          case "is":
            return (v ?? null) === f.value;
          case "in":
            return (f.value as unknown[]).includes(v);
          case "not.in":
            return !(f.value as unknown[]).includes(v);
          case "gt":
            return String(v) > String(f.value);
          case "lt":
            return String(v) < String(f.value);
          default:
            return true;
        }
      });
    }
    return rows;
  };

  const run = (record: Recorded): { data: Row[] | null; error: { code?: string; message?: string } | null } => {
    const source = tables[record.table];
    if (source && !Array.isArray(source)) return { data: null, error: source.error };
    const rows = (tables[record.table] = source ?? []) as Row[];

    if (record.op === "insert") {
      const inserted = (Array.isArray(record.payload) ? record.payload : [record.payload]) as Row[];
      const unique = options.unique?.[record.table];
      for (const row of inserted) {
        if (unique && row[unique] !== undefined && rows.some((r) => r[unique] === row[unique])) return { data: null, error: { code: "23505", message: "duplicate key value" } };
      }
      const added = inserted.map((row) => ({ id: `generated-${++counter}`, ...row }));
      rows.push(...added);
      return { data: added, error: null };
    }
    if (record.op === "update") {
      const changed = matching(record, rows);
      for (const row of changed) Object.assign(row, record.payload as Row);
      return { data: changed, error: null };
    }
    let found = matching(record, rows);
    if (record.order) {
      const { column, ascending } = record.order;
      found.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (ascending ? 1 : -1));
    }
    if (record.limit !== undefined) found = found.slice(0, record.limit);
    return { data: found, error: null };
  };

  const db = {
    from(table: string) {
      const record: Recorded = { table, op: "select", select: "", filters: [] };
      calls.push(record);
      const builder = {
        select: (columns: string) => ((record.select = columns), builder),
        update: (payload: unknown) => ((record.op = "update"), (record.payload = payload), builder),
        insert: (payload: unknown) => ((record.op = "insert"), (record.payload = payload), builder),
        eq: (column: string, value: unknown) => (record.filters.push({ column, op: "eq", value }), builder),
        is: (column: string, value: unknown) => (record.filters.push({ column, op: "is", value }), builder),
        in: (column: string, value: unknown) => (record.filters.push({ column, op: "in", value }), builder),
        not: (column: string, op: string, value: unknown) => {
          const list = typeof value === "string" ? value.replace(/^\(|\)$/g, "").split(",") : value;
          record.filters.push({ column, op: `not.${op}`, value: list });
          return builder;
        },
        gt: (column: string, value: unknown) => (record.filters.push({ column, op: "gt", value }), builder),
        lt: (column: string, value: unknown) => (record.filters.push({ column, op: "lt", value }), builder),
        order: (column: string, opts?: { ascending?: boolean }) => ((record.order = { column, ascending: opts?.ascending ?? true }), builder),
        limit: (n: number) => ((record.limit = n), builder),
        abortSignal: () => builder,
        maybeSingle: () => {
          const { data, error } = run(record);
          return Promise.resolve({ data: data?.[0] ?? null, error });
        },
        single: () => {
          const { data, error } = run(record);
          return Promise.resolve({ data: data?.[0] ?? null, error });
        },
        then: (resolve: (value: unknown) => unknown) => resolve(run(record)),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, calls, tables: tables as Record<string, Row[]> };
}

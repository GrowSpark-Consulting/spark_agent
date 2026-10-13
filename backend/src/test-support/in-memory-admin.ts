// A tiny in-memory stand-in for the service-role Supabase client, for tests that run the real router: select, insert and update with the eq, is(null) and gt filters,
// which is all the connect-link service uses. A statement runs in one synchronous step when awaited, like one SQL statement. `connect_links` selects that embed
// `tenants(name)` are joined from the `tenants` table. It is not a general fake: an operation it does not know is a missing method, and fails the test loudly.

type Row = Record<string, unknown>;

export function inMemoryClient(tables: Record<string, Row[]>) {
  const rowsOf = (table: string) => (tables[table] ??= []);
  const from = (table: string) => {
    let op: "select" | "insert" | "update" = "select";
    let values: Row = {};
    let columns = "*";
    let single = false;
    let returning = false;
    const filters: ((row: Row) => boolean)[] = [];
    const pick = (row: Row): Row => {
      if (table === "connect_links" && columns.includes("tenants(name)")) {
        const tenant = rowsOf("tenants").find((t) => t.id === row.tenant_id);
        return { expires_at: row.expires_at, tenants: tenant ? { name: tenant.name } : null };
      }
      if (columns === "*") return { ...row };
      return Object.fromEntries(columns.split(",").map((c) => [c.trim(), row[c.trim()]]));
    };
    const run = () => {
      if (op === "insert") {
        rowsOf(table).push({ ...values });
        return { data: null, error: null };
      }
      const hit = rowsOf(table).filter((row) => filters.every((f) => f(row)));
      if (op === "update") {
        for (const row of hit) Object.assign(row, values);
        return { data: returning ? hit.map(pick) : null, error: null };
      }
      return { data: single ? (hit[0] ? pick(hit[0]) : null) : hit.map(pick), error: null };
    };
    const q: Record<string, unknown> = {
      select(cols: string) {
        columns = cols;
        if (op === "update") returning = true;
        return q;
      },
      insert(v: Row) {
        op = "insert";
        values = v;
        return q;
      },
      update(v: Row) {
        op = "update";
        values = v;
        return q;
      },
      eq(c: string, v: unknown) {
        filters.push((row) => row[c] === v);
        return q;
      },
      is(c: string, v: null) {
        filters.push((row) => (row[c] ?? null) === v);
        return q;
      },
      gt(c: string, v: string) {
        filters.push((row) => typeof row[c] === "string" && (row[c] as string) > v);
        return q;
      },
      maybeSingle() {
        single = true;
        return q;
      },
      then: (resolve: (v: unknown) => void) => resolve(run()),
    };
    return q;
  };
  return { from };
}

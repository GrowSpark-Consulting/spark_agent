import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPublishedTable, PUBLISHED_TABLES, watchableTables } from "./published-tables";

// The list of tables a screen may subscribe to is tied to the migrations that build the supabase_realtime publication.
// This reads them (read-only) and fails when they and the list disagree. A failure means a migration changed what is
// published: update published-tables.ts deliberately, and check on staging that changes really arrive, not this test.
// It proves what the migration FILES say; it does not prove the hosted database has applied them (only a look at the
// staging project can).

const dir = join(process.cwd(), "..", "supabase", "migrations");

/** Tables a migration adds to the publication: a loop over a literal array, or a named `add table`. */
function publishedBy(sql: string): string[] {
  if (!sql.includes("supabase_realtime")) return [];
  const tables = new Set<string>();
  for (const m of sql.matchAll(/foreach\s+\w+\s+in\s+array\s+array\[([^\]]*)\]/g)) {
    for (const q of m[1].matchAll(/'([a-z_]+)'/g)) tables.add(q[1]);
  }
  for (const m of sql.matchAll(/add\s+table\s+public\.([a-z_]+)/g)) tables.add(m[1]);
  return [...tables];
}

describe("the tables the database publishes to Realtime", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const fromMigrations = [...new Set(files.flatMap((f) => publishedBy(readFileSync(join(dir, f), "utf8"))))].sort();

  it("matches the list screens may subscribe to", () => {
    expect([...PUBLISHED_TABLES].sort()).toEqual(fromMigrations);
  });

  it("does not yet include leads or bookings, so those screens refresh by hand until a migration publishes them", () => {
    // If this fails because a migration now publishes them, that is the news: update the list, then verify on staging.
    expect(fromMigrations).not.toContain("leads");
    expect(fromMigrations).not.toContain("bookings");
  });
});

describe("watchableTables", () => {
  it("keeps only published tables, once each, in the order asked", () => {
    expect(watchableTables(["leads", "messages", "bookings", "messages", "handoffs"])).toEqual(["messages", "handoffs"]);
  });

  it("is empty for tables that are not published", () => {
    expect(watchableTables(["leads", "bookings"])).toEqual([]);
    expect(watchableTables([])).toEqual([]);
  });

  it("recognises the published ones", () => {
    expect(isPublishedTable("kb_documents")).toBe(true);
    expect(isPublishedTable("leads")).toBe(false);
  });
});

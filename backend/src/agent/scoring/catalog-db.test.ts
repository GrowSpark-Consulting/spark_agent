import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createCatalogLoader, MAX_CATALOG_ROWS } from "./catalog-db";

const T = "e0000000-0000-0000-0000-00000000000a";

// A query builder that records what was asked and answers with `result`, like the supabase client does (every call returns the builder; awaiting it gives the result).
function fakeDb(result: { data?: unknown; error?: { code?: string } | null }) {
  const calls: { table: string; select: string; filters: [string, unknown][]; limit?: number }[] = [];
  const db = {
    from(table: string) {
      const call: (typeof calls)[number] = { table, select: "", filters: [] };
      calls.push(call);
      const builder = {
        select: (columns: string) => ((call.select = columns), builder),
        eq: (column: string, value: unknown) => (call.filters.push([column, value]), builder),
        limit: (n: number) => ((call.limit = n), builder),
        abortSignal: () => builder,
        then: (resolve: (value: unknown) => unknown) => resolve({ data: result.data ?? null, error: result.error ?? null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe("reading a business's catalog for scoring", () => {
  it("reads only this business's active items, only the columns scoring needs, capped", async () => {
    const { db, calls } = fakeDb({ data: [] });
    await createCatalogLoader(db)(T);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: "catalog_items", select: "type, price_from, attributes", limit: MAX_CATALOG_ROWS });
    expect(calls[0].filters).toEqual([["tenant_id", T], ["active", true]]);
  });

  it("gives the rows as the scoring code reads them", async () => {
    const { db } = fakeDb({ data: [{ type: "property", price_from: 6_000_000, attributes: { area: "OMR" }, title: "never selected", summary: "x" }] });
    expect(await createCatalogLoader(db)(T)).toEqual([{ type: "property", priceFrom: 6_000_000, attributes: { area: "OMR" } }]);
  });

  it("a row with no price or odd attributes is kept with what is usable, and a row that is not a row is skipped", async () => {
    const { db } = fakeDb({ data: [{ type: "property", price_from: null, attributes: null }, { type: 5 }, "nope", null, { type: "property", price_from: 1, attributes: [1, 2] }] });
    expect(await createCatalogLoader(db)(T)).toEqual([
      { type: "property", priceFrom: null, attributes: {} },
      { type: "property", priceFrom: 1, attributes: {} },
    ]);
  });

  it("a database error is thrown, with the code only", async () => {
    const { db } = fakeDb({ error: { code: "42501" } });
    await expect(createCatalogLoader(db)(T)).rejects.toThrow("database error 42501");
  });

  it("a query that never answers times out", async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: () => ({ abortSignal: () => new Promise(() => undefined) }) }) }) }) }) } as unknown as SupabaseClient;
    await expect(createCatalogLoader(db, 20)(T)).rejects.toThrow(/timed out/);
  });
});

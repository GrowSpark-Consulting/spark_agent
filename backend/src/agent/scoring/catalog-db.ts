import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { withTimeout } from "../../lib/timeout";
import type { CatalogRow } from "./references";

// Reads the business's catalog items for scoring (references.ts turns them into the price bands, areas and cheapest price).
// Read only, with the service role, so every query names the business. Only the columns scoring needs, and only active items.

export const MAX_CATALOG_ROWS = 200;
export const CATALOG_READ_TIMEOUT_MS = 5000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function createCatalogLoader(db?: SupabaseClient, timeoutMs = CATALOG_READ_TIMEOUT_MS): (tenantId: string) => Promise<CatalogRow[]> {
  return async (tenantId) => {
    const client = db ?? supabaseAdmin();
    const { data, error } = await withTimeout(
      (signal) => client.from("catalog_items").select("type, price_from, attributes").eq("tenant_id", tenantId).eq("active", true).limit(MAX_CATALOG_ROWS).abortSignal(signal),
      timeoutMs,
    );
    // The code only: a catalog row can hold the business's own text.
    if (error) throw new Error(`the catalog could not be read (database error ${error.code || "none"})`);
    const rows: CatalogRow[] = [];
    for (const row of Array.isArray(data) ? data : []) {
      if (!isObject(row) || typeof row.type !== "string") continue;
      rows.push({ type: row.type, priceFrom: typeof row.price_from === "number" ? row.price_from : null, attributes: isObject(row.attributes) ? row.attributes : {} });
    }
    return rows;
  };
}

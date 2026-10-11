"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { subscribeToTableChanges, type TableChangeState } from "./table-changes";

/**
 * Tells a screen when to read its data again, and whether updates are arriving live. `tables` is what the screen cares
 * about; only published ones are subscribed to (published-tables.ts). The subscription is dropped when the screen
 * unmounts, the business changes or the tables change, and a new one starts for the new business only.
 */
export function useTableRefresh(tenantId: string, tables: readonly string[], onRefresh: () => Promise<void> | void): TableChangeState {
  const [state, setState] = useState<TableChangeState>("connecting");
  const refresh = useEffectEvent(onRefresh);
  const key = tables.join(",");

  useEffect(() => {
    return subscribeToTableChanges({
      client: getSupabaseBrowserClient(),
      tenantId,
      tables: key === "" ? [] : key.split(","),
      screen: key,
      onRefresh: () => refresh(),
      onState: setState,
    });
  }, [tenantId, key]);

  return state;
}

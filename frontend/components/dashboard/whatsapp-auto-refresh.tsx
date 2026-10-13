"use client";

import type { ConnectionStatus } from "@pakka/types";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { MIN_REFRESH_GAP_MS, refreshIntervalMs } from "@/lib/whatsapp/auto-refresh";

// Reads the WhatsApp screen again on a timer and when the tab is shown again, so a number that failed overnight (Dev 1's daily health check)
// or finished connecting appears without a manual reload. It renders nothing. The page is a server component, so a refresh re-reads
// whatsapp_connections_public as the signed-in member; nothing is kept here. Paused while the tab is hidden.
export function WhatsAppAutoRefresh({ statuses }: { statuses: readonly ConnectionStatus[] }) {
  const router = useRouter();
  const last = useRef(0);
  const wait = refreshIntervalMs(statuses);

  useEffect(() => {
    if (wait === null) return;
    last.current = Date.now();
    const refresh = () => {
      last.current = Date.now();
      router.refresh();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, wait);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last.current >= MIN_REFRESH_GAP_MS) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [wait, router]);

  return null;
}

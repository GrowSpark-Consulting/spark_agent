"use client";

import * as React from "react";
import { loadSavedConnection, type SavedConnection } from "@/lib/whatsapp/saved-connection";

export type SavedConnectionPhase = { phase: "loading" } | ({ phase: "loaded" } & SavedConnection);

/**
 * Reads the business's saved WhatsApp connection from the database when the step opens (and again on reload()), so what the step says
 * never depends on what React remembered. `onLoaded` gets each finished read, to bring the wizard's own copy in line with it.
 */
export function useSavedConnection(onLoaded: (result: SavedConnection) => void) {
  const [phase, setPhase] = React.useState<SavedConnectionPhase>({ phase: "loading" });
  const [version, setVersion] = React.useState(0);
  const onLoadedRef = React.useRef(onLoaded);
  React.useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  React.useEffect(() => {
    let live = true;
    loadSavedConnection().then(
      (result) => {
        if (!live) return;
        setPhase({ phase: "loaded", ...result });
        onLoadedRef.current(result);
      },
      () => live && setPhase({ phase: "loaded", state: "error", message: "We couldn’t check your WhatsApp connection. Try again in a moment.", retryable: true }),
    );
    return () => {
      live = false;
    };
  }, [version]);

  // Called from a click or a finished request, never from an effect: it shows "checking" again and reads again.
  const reload = React.useCallback(() => {
    setPhase({ phase: "loading" });
    setVersion((n) => n + 1);
  }, []);
  return { saved: phase, reload };
}

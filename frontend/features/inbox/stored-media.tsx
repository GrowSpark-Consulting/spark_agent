"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { createSignedUrlCache, INLINE_IMAGE_TYPES, storageSigner, storedMediaPath } from "./media-url";

// A photo or document the download job has stored, drawn in a chat bubble. The signed link is made on the member's own session
// (media-url.ts), once per file per hour however often this re-renders, and is only ever used as an <img> source or a link the person presses.
// The storage path itself is never rendered. Saying why a file can't be shown is part of the job: loading, couldn't load (with Try again),
// and a type that isn't drawn here (opened from a link instead).

// One cache for the page; it is keyed by the full path, which starts with the business id, so one business's links are never another's.
let cache: ReturnType<typeof createSignedUrlCache> | null = null;
const urls = () => (cache ??= createSignedUrlCache(storageSigner(getSupabaseBrowserClient())));

type State = { status: "loading" } | { status: "ready"; url: string } | { status: "failed" };

export function StoredMedia({
  path,
  mime,
  name,
  tenantId,
  conversationId,
}: {
  path: unknown;
  mime: string | null;
  name: string;
  tenantId: string;
  conversationId: string;
}) {
  const safePath = storedMediaPath(path, tenantId, conversationId);
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Once per file: a link that stops working (it expired while the page was open) is replaced one time before the person is told.
  const [reSigned, setReSigned] = useState(false);

  useEffect(() => {
    if (!safePath) return;
    let live = true;
    urls()
      .get(safePath)
      .then(
        (url) => live && setState({ status: "ready", url }),
        () => live && setState({ status: "failed" }),
      );
    return () => {
      live = false;
    };
  }, [safePath, attempt]);

  const retry = useCallback(() => {
    if (safePath) urls().forget(safePath);
    setReSigned(false);
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, [safePath]);

  // Not a file of this chat: nothing to sign, nothing to link.
  if (!safePath) return null;

  const drawable = mime !== null && INLINE_IMAGE_TYPES.includes(mime);
  const note = { fontSize: "12px", opacity: 0.7, display: "block" } as const;

  if (state.status === "loading") {
    return (
      <span role="status" data-testid="media-loading" style={note}>
        Loading the file…
      </span>
    );
  }
  if (state.status === "failed") {
    return (
      <span role="alert" data-testid="media-failed" style={note}>
        Couldn&apos;t load this file.{" "}
        <button type="button" className="btn btn-ghost" onClick={retry} style={{ minHeight: 32, padding: "0 6px" }}>
          Try again
        </button>
      </span>
    );
  }
  if (drawable) {
    return (
      <a href={state.url} target="_blank" rel="noopener noreferrer" data-testid="media-image-link" aria-label={`Open ${name}`} style={{ display: "block" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link to a private file: next/image would proxy and cache it */}
        <img
          src={state.url}
          alt={name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          style={{ display: "block", maxWidth: "100%", maxHeight: "320px", objectFit: "contain", background: "rgba(0,0,0,.05)" }}
          onError={() => {
            if (reSigned) return setState({ status: "failed" });
            setReSigned(true);
            urls().forget(safePath);
            setState({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
        />
      </a>
    );
  }
  return (
    <a href={state.url} target="_blank" rel="noopener noreferrer" data-testid="media-document-link" style={{ fontSize: "13px", fontWeight: 600 }}>
      Open {name}
    </a>
  );
}

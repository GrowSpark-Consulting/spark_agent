"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { WHATSAPP_TEXT_MAX } from "@pakka/types";
import type { FormattedError } from "@/lib/errors";
import { replyFailure, sendStaffReply, type ReplyFailure } from "./staff-reply";
import { languageLabel, placeSuggestion, requestSuggestion, suggestionFailure } from "./suggest-reply";

// The reply box under an open chat while its 24-hour window is open (the closed-window strip stays in
// chat-view.tsx). Sends through the API, never optimistically: the message appears in the chat when
// realtime delivers the stored row. The draft is kept on any failure. Enter sends, Shift+Enter adds a line.
// Mounted with key={conversation.id}, so a draft never moves to another chat.
//
// "Suggest reply" asks the API for a reply staff can send as it is (suggest-reply.ts). It only ever fills the box:
// nothing is sent until the staff member presses Send, and a draft they already typed is never replaced without
// their saying so. An answer that arrives after the chat was left, or after a message was sent meanwhile, is dropped.

type Pending = { reply: string; language: string | null };

export function ReplyComposer({ tenantId, conversationId }: { tenantId: string; conversationId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<ReplyFailure | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [suggestFailed, setSuggestFailed] = useState<FormattedError | null>(null);
  // Refs, not state: two quick presses must not both pass a check before a re-render.
  const inFlight = useRef(false);
  const suggestInFlight = useRef(false);
  const mounted = useRef(true);
  /** The draft as it is now, for a suggestion that arrives later. */
  const draft = useRef("");
  /** How many messages this box has sent: a suggestion asked for before a send is out of date after it. */
  const sentCount = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  const suggestErrorId = useId();
  const body = text.trim();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function edit(next: string) {
    draft.current = next;
    setText(next);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (inFlight.current || body === "" || body.length > WHATSAPP_TEXT_MAX) return;
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    try {
      await sendStaffReply(tenantId, conversationId, body);
      sentCount.current += 1;
      edit("");
      setPending(null);
      setSuggestNote(null);
    } catch (err) {
      setFailure(replyFailure(err));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  async function suggest() {
    if (suggestInFlight.current || inFlight.current) return;
    suggestInFlight.current = true;
    const sentBefore = sentCount.current;
    setSuggesting(true);
    setPending(null);
    setSuggestNote(null);
    setSuggestFailed(null);
    try {
      const result = await requestSuggestion(tenantId, conversationId);
      if (!mounted.current) return;
      if (sentCount.current !== sentBefore) {
        setSuggestNote("A message was sent while the suggestion loaded, so it wasn’t added. Ask again for a fresh one.");
      } else if (result.kind === "unavailable") {
        setSuggestNote("No suggestion this time. Write your own reply.");
      } else if (placeSuggestion(draft.current) === "fill") {
        edit(result.reply);
        const language = languageLabel(result.language);
        setSuggestNote(`Suggested reply added${language ? ` in ${language}` : ""}. Read it before you send.`);
        textarea.current?.focus();
      } else {
        setPending({ reply: result.reply, language: result.language });
      }
    } catch (err) {
      if (mounted.current) setSuggestFailed(suggestionFailure(err));
    } finally {
      suggestInFlight.current = false;
      if (mounted.current) setSuggesting(false);
    }
  }

  function applySuggestion() {
    if (!pending) return;
    edit(pending.reply);
    const language = languageLabel(pending.language);
    setSuggestNote(`Suggested reply added${language ? ` in ${language}` : ""}. Read it before you send.`);
    setPending(null);
    textarea.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  const tooLong = body.length > WHATSAPP_TEXT_MAX;
  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void suggest()}
          disabled={suggesting || sending}
          aria-busy={suggesting || undefined}
          aria-describedby={suggestFailed ? suggestErrorId : undefined}
          style={{ minHeight: "36px", fontSize: "13px", cursor: suggesting ? "progress" : undefined }}
        >
          {suggesting ? "Suggesting…" : "Suggest reply"}
        </button>
        {suggestNote ? (
          <span role="status" style={{ fontSize: "13px" }}>
            {suggestNote}
          </span>
        ) : null}
      </div>
      {pending ? (
        <div role="group" aria-label="Suggested reply" style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "10px", background: "var(--color-surface)" }}>
          <div style={{ fontSize: "13px", fontWeight: 700 }}>
            Suggested reply{languageLabel(pending.language) ? ` · ${languageLabel(pending.language)}` : ""}
          </div>
          <div data-testid="suggested-reply-preview" style={{ fontSize: "14px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {pending.reply}
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-secondary" onClick={applySuggestion} style={{ minHeight: "36px", fontSize: "13px" }}>
              Replace my draft
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setPending(null)} style={{ minHeight: "36px", fontSize: "13px" }}>
              Keep my draft
            </button>
          </div>
        </div>
      ) : null}
      {suggestFailed ? (
        <div id={suggestErrorId} role="alert" style={{ fontSize: "13px", padding: "8px 10px", background: "var(--color-surface)" }}>
          <strong>Couldn’t get a suggestion.</strong> {suggestFailed.message} Your draft is untouched.
        </div>
      ) : null}
      <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
        <textarea
          ref={textarea}
          className="input"
          aria-label="Message"
          aria-describedby={failure ? errorId : undefined}
          aria-invalid={failure || tooLong ? true : undefined}
          placeholder="Write a reply"
          rows={1}
          value={text}
          readOnly={sending}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
          style={{ flex: "1", minWidth: "0", minHeight: "44px", maxHeight: "140px", fontSize: "15px", resize: "none", fieldSizing: "content" } as React.CSSProperties}
        />
        <button
          type="submit"
          aria-label={sending ? "Sending" : "Send"}
          disabled={sending || body === "" || tooLong}
          style={{ width: "44px", height: "44px", flex: "none", background: "var(--wa-dark)", color: "#fff", border: "0", display: "grid", placeItems: "center", cursor: sending ? "progress" : "pointer", opacity: sending || body === "" || tooLong ? 0.4 : 1 }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" style={{ strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }}>
            <path d="m22 2-7 20-4-9-9-4Z" />
            <path d="M22 2 11 13" />
          </svg>
        </button>
      </div>
      {tooLong ? (
        <div role="status" style={{ fontSize: "13px", fontWeight: "700" }}>
          Keep it under {WHATSAPP_TEXT_MAX} characters.
        </div>
      ) : null}
      {failure ? (
        <div id={errorId} role="alert" style={{ fontSize: "13px", padding: "8px 10px", background: "var(--color-surface)" }}>
          <strong>{failure.maybeSent ? "Couldn’t confirm it was sent." : "Not sent."}</strong> {failure.message}
          {failure.maybeSent ? " Check the chat before sending it again." : " Your message is still here."}
        </div>
      ) : null}
    </form>
  );
}

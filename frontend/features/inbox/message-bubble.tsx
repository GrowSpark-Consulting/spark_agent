import type { CSSProperties } from "react";
import { formatClock, type ChatMessage } from "./data";
import { storedMediaPath } from "./media-url";
import { StoredMedia } from "./stored-media";

// One chat message, ported from the /dashboard/preview Inbox (components/dashboard/pakka-app.tsx):
// customer messages on the left in --wa-in, everything we sent on the right in --wa-out with a
// sender label, system events as a centred note. Styles are the prototype's, unchanged.

/** No persona name or staff names exist yet (see data.ts), so the labels say what sent it. */
const WHO: Partial<Record<ChatMessage["sender"], { label: string; color: string }>> = {
  ai: { label: "AI", color: "var(--wa-dark)" },
  staff: { label: "Staff", color: "#c2410c" },
};

/** `tenantId` and `conversationId` say which business and chat this bubble is in: only a stored file of that chat is ever signed. */
export function MessageBubble({ message, timeZone, tenantId, conversationId }: { message: ChatMessage; timeZone: string; tenantId?: string; conversationId?: string }) {
  if (message.sender === "system") {
    return (
      <div style={{ alignSelf: "center", maxWidth: "90%", textAlign: "center", fontSize: "12px", background: "var(--wa-sys)", color: "var(--wa-ink)", padding: "5px 10px", margin: "4px 0" }}>
        {message.body ?? (message.templateName ? `Template sent · ${message.templateName}` : "")}
      </div>
    );
  }

  const outgoing = message.sender !== "customer";
  const who = WHO[message.sender];
  const { text, attachment } = message;
  // A stored file is only shown when its path is a file of this business and chat (media-url.ts); anything else says so, and is never signed.
  const stored = attachment?.file && tenantId && conversationId ? storedMediaPath(attachment.file.path, tenantId, conversationId) : null;
  const attachmentNote = attachment?.note ?? (attachment?.file && !stored ? "Can't be shown here" : undefined);

  return (
    <div
      data-sender={message.sender}
      data-kind={message.kind ?? undefined}
      style={{
        alignSelf: outgoing ? "flex-end" : "flex-start",
        maxWidth: "var(--inbox-bubble-max, 72%)",
        background: outgoing ? "var(--wa-out)" : "var(--wa-in)",
        color: "var(--wa-ink)",
        padding: "6px 9px 4px",
        boxShadow: "0 1px 0.5px rgba(11,20,26,.13)",
        overflowWrap: "anywhere",
      } as CSSProperties}
    >
      {outgoing && who ? (
        <div style={{ fontSize: "12px", fontWeight: "600", color: who.color, marginBottom: "2px" }}>{who.label}</div>
      ) : null}
      {attachment ? (
        <div style={{ display: "flex", gap: "10px", alignItems: "center", background: "rgba(0,0,0,.05)", padding: "8px", marginBottom: "4px", minWidth: "min(220px, 100%)" }}>
          <span style={{ width: "32px", height: "38px", flex: "none", background: "#e2412f", color: "#fff", fontSize: "10px", fontWeight: "800", display: "grid", placeItems: "center" }}>
            {attachment.label}
          </span>
          <span style={{ fontSize: "13px", lineHeight: "1.3", minWidth: "0" }}>
            <span style={{ fontWeight: "600", display: "block" }}>{attachment.name}</span>
            {attachmentNote ? <span style={{ display: "block", fontSize: "12px", opacity: ".7" }}>{attachmentNote}</span> : null}
            {attachment.file && stored && tenantId && conversationId ? (
              <StoredMedia path={stored} mime={attachment.file.mime} name={attachment.name} tenantId={tenantId} conversationId={conversationId} />
            ) : null}
          </span>
        </div>
      ) : null}
      {text ? (
        <div
          style={{
            fontSize: "14px",
            lineHeight: "1.4",
            whiteSpace: "pre-wrap",
            textWrap: "pretty",
            ...(message.textIsNotice ? { fontStyle: "italic", opacity: ".75" } : {}),
          } as CSSProperties}
        >
          {text}
        </div>
      ) : null}
      <div style={{ fontSize: "11px", opacity: ".6", textAlign: "right", marginTop: "1px" }}>
        <time dateTime={message.createdAt}>{formatClock(message.createdAt, timeZone)}</time>
      </div>
    </div>
  );
}

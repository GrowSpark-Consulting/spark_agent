import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./data";
import { describeMessage } from "./data";
import { MessageBubble } from "./message-bubble";

// A photo or document in a bubble, as static markup (what is on the page before any link has been made). The signed link itself, the retry and
// the expiry are checked in tests/e2e/app/inbox-media.spec.ts and media-url.test.ts.

const TENANT = "10000000-0000-0000-0000-000000000004";
const CHAT = "40000000-0000-0000-0000-000000000002";
const PATH = `${TENANT}/${CHAT}/41000000-0000-0000-0000-000000000009.jpg`;

function bubble(media: unknown, kind = "image", ids: { tenantId?: string; conversationId?: string } = { tenantId: TENANT, conversationId: CHAT }) {
  const display = describeMessage({ kind, body: null, media, meta: {}, templateName: null });
  const message = { id: "m", sender: "customer", kind, body: null, templateName: null, createdAt: "2026-10-15T08:00:00.000Z", text: display.text, attachment: display.attachment, textIsNotice: false } as unknown as ChatMessage;
  return renderToStaticMarkup(createElement(MessageBubble, { message, timeZone: "Asia/Kolkata", ...ids }));
}
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();

describe("MessageBubble media", () => {
  it("a stored file of this chat is being loaded, and its path is not on the page", () => {
    const html = bubble({ id: "m", mime: "image/jpeg", path: PATH });
    expect(words(html)).toContain("Loading the file");
    expect(html).not.toContain(PATH);
    expect(html).not.toContain(TENANT);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
  });

  it("a path for another business or chat is not signed and says so", () => {
    for (const path of [PATH.replace(TENANT, "10000000-0000-0000-0000-0000000000ff"), `../${PATH}`, "https://evil.example/x.jpg"]) {
      const html = bubble({ id: "m", mime: "image/jpeg", path });
      expect(words(html), path).toContain("Can't be shown here");
      expect(html).not.toContain("Loading the file");
      expect(html).not.toContain(path);
    }
  });

  it("without the business and chat there is nothing to check a path against, so it is not signed", () => {
    const html = bubble({ id: "m", mime: "image/jpeg", path: PATH }, "image", {});
    expect(words(html)).toContain("Can't be shown here");
    expect(html).not.toContain(PATH);
  });

  it("a file left out says why, and an unstored one keeps its placeholder", () => {
    expect(words(bubble({ id: "m", mime: "image/jpeg", skipped: "too_big" }))).toContain("Too large to keep");
    expect(words(bubble({ id: "m", mime: "image/jpeg" }))).toContain("Can't be shown here yet");
    expect(words(bubble({ id: "m", mime: "audio/ogg", path: PATH.replace(".jpg", ".ogg") }, "audio"))).toContain("Can't be played here yet");
  });
});

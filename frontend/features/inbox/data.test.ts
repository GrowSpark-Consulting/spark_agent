import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  applyConversationChange,
  applyHandoffChange,
  applyMessageToList,
  attachmentOf,
  conversationTag,
  dayChipLabel,
  fetchConversation,
  fetchConversations,
  fetchMessages,
  formatListTime,
  groupByDay,
  handoffReason,
  initialsOf,
  InboxDataError,
  isWindowOpen,
  lastWrotePhrase,
  maskPhoneForDisplay,
  matchesFilter,
  matchesSearch,
  MessageRow,
  sortConversations,
  toChatMessage,
  toConversationSummary,
  ConversationListRow,
  ReadSequencer,
  upsertMessage,
  type ChatMessage,
  type ConversationSummary,
} from "./data";

const TENANT = "c0000000-0000-0000-0000-00000000000a";
const OTHER_TENANT = "c0000000-0000-0000-0000-00000000000b";
const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-07T06:30:00Z"); // 12:00 pm in Chennai, Wed 7 Oct

const id = (n: number) => `a0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function listRow(over: Partial<ConversationListRow> = {}): ConversationListRow {
  return {
    id: id(1),
    tenant_id: TENANT,
    contact_id: id(201),
    mode: "ai",
    status: "open",
    last_customer_msg_at: "2026-10-07T04:00:00+00:00",
    created_at: "2026-10-06T10:00:00+00:00",
    contacts: { name: "Karthik R", phone: "+919812345621", language: "ta" },
    handoffs: [],
    messages: [{ id: id(101), sender: "customer", body: "Velachery 3BHK irukka?", media: null, template_name: null, created_at: "2026-10-07T04:12:00+00:00" }],
    ...over,
  };
}

function messageRow(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: id(201),
    tenant_id: TENANT,
    conversation_id: id(1),
    direction: "in",
    sender: "customer",
    body: "Hi",
    media: null,
    template_name: null,
    delivery_status: null,
    created_at: "2026-10-07T04:12:00+00:00",
    ...over,
  };
}

const summary = (over: Partial<ConversationListRow> = {}): ConversationSummary =>
  toConversationSummary(ConversationListRow.parse(listRow(over)));
const chatMessage = (over: Partial<MessageRow> = {}): ChatMessage => toChatMessage(MessageRow.parse(messageRow(over)));

/** A chainable stand-in for the PostgREST query builder that records every call. */
function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  let table = "";
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "eq", "is", "neq", "order", "limit"]) {
    builder[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const client = {
    from: (t: string) => {
      table = t;
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls, table: () => table };
}

describe("mapping rows to the inbox view model", () => {
  it("maps a conversation with its contact and latest message", () => {
    const c = summary();
    expect(c).toMatchObject({
      name: "Karthik R",
      firstName: "Karthik",
      initials: "KR",
      phoneMasked: "+91 98xxx xxx21",
      language: "Tamil",
      mode: "ai",
      openHandoffs: [],
      lastMessage: { id: id(101), sender: "customer", preview: "Velachery 3BHK irukka?", at: "2026-10-07T04:12:00.000Z" },
    });
  });

  it("never renders the full number, and falls back to it (masked) when the contact has no name", () => {
    const c = summary({ contacts: { name: null, phone: "+971501234514", language: null } });
    expect(c.name).toBe("+97xxxxxxxx14");
    expect(c.initials).toBe("#");
    expect(c.firstName).toBe("This customer");
    expect(JSON.stringify({ ...c, phoneDigits: undefined })).not.toContain("501234514");
  });

  it("prefixes previews by sender and never invents a persona or staff name", () => {
    expect(summary({ messages: [{ id: id(1), sender: "ai", body: "Hello!", media: null, template_name: null, created_at: "2026-10-07T04:12:00Z" }]}).lastMessage?.preview).toBe("AI: Hello!");
    expect(summary({ messages: [{ id: id(1), sender: "staff", body: "On my way", media: null, template_name: null, created_at: "2026-10-07T04:12:00Z" }]}).lastMessage?.preview).toBe("Staff: On my way");
    expect(summary({ messages: [{ id: id(1), sender: "staff", body: null, media: null, template_name: "reminder_24h_v1", created_at: "2026-10-07T04:12:00Z" }]}).lastMessage?.preview).toBe("Staff: Template · reminder_24h_v1");
  });

  it("has no last message when the chat has none", () => {
    expect(summary({ messages: [] }).lastMessage).toBeNull();
  });

  it("accepts Realtime's timestamp format", () => {
    const m = chatMessage({ created_at: "2026-10-07 04:12:00.123456+00" });
    expect(m.createdAt).toBe("2026-10-07T04:12:00.123Z");
  });

  it("rejects rows that aren't messages", () => {
    expect(MessageRow.safeParse({ ...messageRow(), sender: "bot" }).success).toBe(false);
    expect(MessageRow.safeParse({ ...messageRow(), created_at: "yesterday" }).success).toBe(false);
  });

  it("reads only a kind and a file name from media", () => {
    expect(attachmentOf({ kind: "document", name: "Aster brochure.pdf", url: "https://x" })).toEqual({ label: "PDF", name: "Aster brochure.pdf" });
    expect(attachmentOf({ type: "image" })).toEqual({ label: "IMG", name: "Image" });
    expect(attachmentOf(null)).toBeNull();
    expect(attachmentOf("x")).toBeNull();
  });

  it("shows mime-only media (no kind) by its mime type, never as an empty attachment", () => {
    expect(attachmentOf({ id: "m1", mime: "image/jpeg" })).toEqual({ label: "IMG", name: "Photo", note: "Can't be shown here yet" });
    expect(attachmentOf({ id: "m2", mime: "audio/ogg; codecs=opus" })).toEqual({ label: "AUD", name: "Voice message", note: "Can't be played here yet" });
    expect(attachmentOf({ id: "m3", mime: "application/pdf" })).toEqual({ label: "PDF", name: "Document", note: "Can't be opened here yet" });
    expect(attachmentOf({ id: "m4" })).toBeNull();
  });

  it("says why a file was left out when the download job marked it skipped or unavailable, and never shows its path", () => {
    expect(attachmentOf({ id: "m1", mime: "image/jpeg", skipped: "too_big" })).toEqual({ label: "IMG", name: "Photo", note: "Too large to keep" });
    expect(attachmentOf({ id: "m3", mime: "application/pdf", skipped: "type_not_allowed" })).toEqual({ label: "PDF", name: "Document", note: "This file type isn't kept" });
    expect(attachmentOf({ id: "m1", mime: "image/jpeg", unavailable: "media_gone" })).toEqual({ label: "IMG", name: "Photo", note: "WhatsApp no longer has this file" });
    expect(attachmentOf({ id: "m1", mime: "image/jpeg", unavailable: "bad_answer" })?.note).toBe("WhatsApp wouldn't hand this file over");
    expect(attachmentOf({ id: "m1", mime: "image/jpeg", skipped: "token_rejected" })?.note).toBe("Wasn't saved");
  });

  it("a stored image or document carries its path for media-url.ts to check and sign, with no note, and a left-out or audio file never does", () => {
    const image = attachmentOf({ id: "m1", mime: "image/jpeg", path: "t/c/m.jpg", size: 10 });
    expect(image).toEqual({ label: "IMG", name: "Photo", file: { path: "t/c/m.jpg", mime: "image/jpeg" } });
    const doc = attachmentOf({ id: "m3", mime: "application/pdf; charset=binary", path: "t/c/m.pdf" });
    expect(doc).toEqual({ label: "PDF", name: "Document", file: { path: "t/c/m.pdf", mime: "application/pdf" } });
    // the same file with a reason it was left out: the reason wins, no path is carried
    expect(attachmentOf({ id: "m1", mime: "image/jpeg", path: "t/c/m.jpg", skipped: "too_big" })).toEqual({ label: "IMG", name: "Photo", note: "Too large to keep" });
    // a voice message is never stored for viewing here
    expect(attachmentOf({ id: "m2", mime: "audio/ogg", path: "t/c/m.ogg" })?.file).toBeUndefined();
    // a path that is not text is not a path
    expect(attachmentOf({ id: "m1", mime: "image/jpeg", path: 5 })).toEqual({ label: "IMG", name: "Photo", note: "Can't be shown here yet" });
  });

  it("makes initials from the first two words", () => {
    expect(initialsOf("Lakshmi")).toBe("L");
    expect(initialsOf("mohammed abdul rahim")).toBe("MA");
    expect(initialsOf("  ")).toBe("#");
  });
});

// The inbound rows #50 stores (docs/task-notes/2026-10-08-feat-agent-webhook-post.md, section 6):
// kind, body, media { id, mime } and meta by kind. Files aren't downloaded, so there is never a URL.
describe("inbound message kinds (migration 0013)", () => {
  const inbound = (over: Partial<MessageRow>) => chatMessage({ media: null, meta: {}, ...over });
  const shown = (m: ChatMessage) => ({ attachment: m.attachment, text: m.text, textIsNotice: m.textIsNotice, preview: m.preview });

  it("leaves text messages as they were", () => {
    expect(shown(inbound({ kind: "text", body: "Velachery 3BHK irukka?" }))).toEqual({
      attachment: null,
      text: "Velachery 3BHK irukka?",
      textIsNotice: false,
      preview: "Velachery 3BHK irukka?",
    });
    // Outbound rows and rows from before 0013 have no kind or meta at all.
    const legacy = chatMessage({ body: "Hi" });
    expect(legacy.kind).toBeNull();
    expect(shown(legacy)).toEqual({ attachment: null, text: "Hi", textIsNotice: false, preview: "Hi" });
    expect(chatMessage({ sender: "ai", direction: "out", body: null, template_name: "reminder_24h_v1" }).text).toBe("Template · reminder_24h_v1");
  });

  it("shows an image with its caption under a placeholder", () => {
    expect(shown(inbound({ kind: "image", body: "This one, near the lake?", media: { id: "wamid-media-1", mime: "image/jpeg" } }))).toEqual({
      attachment: { label: "IMG", name: "Photo", note: "Can't be shown here yet" },
      text: "This one, near the lake?",
      textIsNotice: false,
      preview: "Photo · This one, near the lake?",
    });
  });

  it("shows an image without a caption as the placeholder alone", () => {
    expect(shown(inbound({ kind: "image", body: null, media: { id: "wamid-media-2", mime: "image/webp" } }))).toEqual({
      attachment: { label: "IMG", name: "Photo", note: "Can't be shown here yet" },
      text: null,
      textIsNotice: false,
      preview: "Photo",
    });
  });

  it("shows a document by its type, with a caption, and a file name only if the row has one", () => {
    expect(shown(inbound({ kind: "document", body: "My salary slip", media: { id: "wamid-media-3", mime: "application/pdf" } }))).toEqual({
      attachment: { label: "PDF", name: "Document", note: "Can't be opened here yet" },
      text: "My salary slip",
      textIsNotice: false,
      preview: "Document · My salary slip",
    });
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(inbound({ kind: "document", body: null, media: { id: "m", mime: docx } }).attachment?.label).toBe("DOCX");
    expect(inbound({ kind: "document", body: null, media: { id: "m", mime: "application/zip" } }).attachment?.label).toBe("DOC");
    expect(inbound({ kind: "document", body: null, media: { id: "m", mime: "application/pdf", filename: "Floor plan.pdf" } }).attachment).toEqual({
      label: "PDF",
      name: "Floor plan.pdf",
      note: "Can't be opened here yet",
    });
  });

  it("shows a voice message as a placeholder that can't be played", () => {
    expect(shown(inbound({ kind: "audio", body: null, media: { id: "wamid-media-4", mime: "audio/ogg; codecs=opus" } }))).toEqual({
      attachment: { label: "AUD", name: "Voice message", note: "Can't be played here yet" },
      text: null,
      textIsNotice: false,
      preview: "Voice message",
    });
  });

  it("shows a location as its place and coordinates, with no map", () => {
    expect(shown(inbound({ kind: "location", body: "12.9791,80.2209 Phoenix Marketcity Velachery Main Road, Chennai" }))).toEqual({
      attachment: { label: "LOC", name: "Phoenix Marketcity Velachery Main Road, Chennai", note: "12.9791, 80.2209" },
      text: null,
      textIsNotice: false,
      preview: "Location · Phoenix Marketcity Velachery Main Road, Chennai",
    });
    expect(shown(inbound({ kind: "location", body: "-33.8688,151.2093" }))).toEqual({
      attachment: { label: "LOC", name: "Location", note: "-33.8688, 151.2093" },
      text: null,
      textIsNotice: false,
      preview: "Location",
    });
    // A body in some other form is still shown, as written.
    expect(shown(inbound({ kind: "location", body: "near the temple" }))).toMatchObject({ attachment: { label: "LOC", name: "Location" }, text: "near the temple" });
  });

  it("says a sticker isn't supported, by Meta's own word for it", () => {
    expect(shown(inbound({ kind: "unsupported", body: null, meta: { unsupportedType: "sticker" } }))).toEqual({
      attachment: null,
      text: "Message type not supported (sticker)",
      textIsNotice: true,
      preview: "Message type not supported (sticker)",
    });
    expect(inbound({ kind: "unsupported", body: null, meta: { unsupportedType: "unknown" } }).text).toBe("Message type not supported");
    expect(inbound({ kind: "unsupported", body: null, meta: {} }).text).toBe("Message type not supported");
    expect(inbound({ kind: "unsupported", body: null, meta: { unsupportedType: "<b>x</b>" } }).text).toBe("Message type not supported");
  });

  it("shows an interactive reply as the title the customer chose", () => {
    expect(shown(inbound({ kind: "interactive", body: "Book a site visit", meta: { buttonId: "book_visit" } }))).toEqual({
      attachment: null,
      text: "Book a site visit",
      textIsNotice: false,
      preview: "Book a site visit",
    });
    expect(inbound({ kind: "interactive", body: null, meta: { buttonId: "x" } })).toMatchObject({ text: "Replied with a button", textIsNotice: true });
  });

  it("shows a kind added later from its body, not as a failed read", () => {
    expect(shown(inbound({ kind: "video", body: "Look at this", media: { id: "m", mime: "video/mp4" } }))).toMatchObject({ text: "Look at this", preview: "Look at this" });
    // Nothing to show at all: a notice, never an empty bubble or an empty list preview.
    expect(shown(inbound({ kind: "sticker_pack", body: null, media: null, meta: null }))).toEqual({
      attachment: null,
      text: "Message type not supported",
      textIsNotice: true,
      preview: "Message type not supported",
    });
  });

  it("is safe with null kind, null meta and a missing contact", () => {
    // Legacy and outbound rows: kind and meta stored as null (not just absent) read as plain text.
    expect(shown(chatMessage({ kind: null, meta: null, body: "Hi" }))).toEqual({ attachment: null, text: "Hi", textIsNotice: false, preview: "Hi" });
    expect(inbound({ kind: "unsupported", body: null, meta: null }).text).toBe("Message type not supported");
    // A photo whose media is missing still shows the placeholder.
    expect(inbound({ kind: "image", body: null, media: null }).attachment).toEqual({ label: "IMG", name: "Photo", note: "Can't be shown here yet" });
    // A conversation whose contact row is gone: the masked-number fallback, no crash.
    expect(summary({ contacts: null, messages: [] })).toMatchObject({ name: "Hidden number", firstName: "This customer", initials: "#", phoneMasked: "Hidden number", language: null, lastMessage: null });
  });

  it("uses the same wording in the conversation list and for live updates", () => {
    const c = summary({
      messages: [{ id: id(101), sender: "customer", kind: "unsupported", body: null, media: null, meta: { unsupportedType: "sticker" }, template_name: null, created_at: "2026-10-07T04:12:00+00:00" }],
    });
    expect(c.lastMessage?.preview).toBe("Message type not supported (sticker)");
    const photo = chatMessage({ id: id(202), kind: "image", body: null, media: { id: "m", mime: "image/jpeg" }, meta: {}, created_at: "2026-10-07T05:00:00Z" });
    expect(applyMessageToList([c], photo)?.[0].lastMessage?.preview).toBe("Photo");
  });

  it("reads kind and meta in both message queries", async () => {
    const list = fakeClient({ data: [], error: null });
    await fetchConversations(list.client, TENANT);
    expect(String(list.calls.find(([name]) => name === "select")?.[1][0])).toMatch(/messages \([^)]*\bkind\b[^)]*\bmeta\b[^)]*\)/);
    const chat = fakeClient({ data: [], error: null });
    await fetchMessages(chat.client, TENANT, id(1));
    const columns = String(chat.calls.find(([name]) => name === "select")?.[1][0]).split(", ");
    expect(columns).toEqual(expect.arrayContaining(["kind", "meta", "body", "media"]));
  });
});

describe("AI / Needs human / Human tag", () => {
  it("is AI when the AI handles it and nothing is handed over", () => {
    expect(conversationTag(summary())).toBe("ai");
  });

  it("is Needs human whenever a handoff is open, whatever the mode", () => {
    const open = [{ id: id(301), trigger: "asked_human" }];
    expect(conversationTag(summary({ handoffs: open }))).toBe("needs_human");
    expect(conversationTag(summary({ mode: "human", handoffs: open }))).toBe("needs_human");
  });

  it("follows the conversation's own mode otherwise", () => {
    expect(conversationTag(summary({ mode: "human" }))).toBe("human");
    expect(conversationTag(summary({ mode: "external" }))).toBe("external");
  });

  it("filters like the prototype chips", () => {
    const ai = summary({ id: id(1) });
    const waiting = summary({ id: id(2), handoffs: [{ id: id(301), trigger: "complaint" }] });
    const human = summary({ id: id(3), mode: "human" });
    const all = [ai, waiting, human];
    expect(all.filter((c) => matchesFilter(c, "all"))).toHaveLength(3);
    expect(all.filter((c) => matchesFilter(c, "ai")).map((c) => c.id)).toEqual([id(1)]);
    expect(all.filter((c) => matchesFilter(c, "needs_human")).map((c) => c.id)).toEqual([id(2)]);
  });

  it("explains why a chat was handed over", () => {
    expect(handoffReason("asked_human")).toBe("Asked for a person");
    expect(handoffReason("complaint")).toBe("Upset / complaint");
    expect(handoffReason("opt_out")).toBe("Opted out – don’t WhatsApp unless they write again");
    expect(handoffReason("custom_itinerary")).toBe("custom itinerary");
    expect(handoffReason(undefined)).toBe("handed to your team");
  });
});

describe("search", () => {
  it("matches a name or digits of the number", () => {
    const c = summary();
    expect(matchesSearch(c, "karth")).toBe(true);
    expect(matchesSearch(c, "45621")).toBe(true);
    expect(matchesSearch(c, "priya")).toBe(false);
    expect(matchesSearch(c, "  ")).toBe(true);
  });
});

describe("ordering and live updates", () => {
  const older = summary({ id: id(1), messages: [{ id: id(101), sender: "customer", body: "old", media: null, template_name: null, created_at: "2026-10-07T03:00:00Z" }] });
  const newer = summary({ id: id(2), messages: [{ id: id(102), sender: "customer", body: "new", media: null, template_name: null, created_at: "2026-10-07T05:00:00Z" }] });
  const empty = summary({ id: id(3), messages: [], created_at: "2026-10-07T04:00:00Z" });

  it("sorts by latest message, falling back to when the chat was created", () => {
    expect(sortConversations([older, empty, newer]).map((c) => c.id)).toEqual([id(2), id(3), id(1)]);
  });

  it("moves a chat to the top when a newer message arrives", () => {
    const next = applyMessageToList([newer, older], chatMessage({ id: id(500), conversation_id: id(1), created_at: "2026-10-07T06:00:00Z", body: "latest" }));
    expect(next?.map((c) => c.id)).toEqual([id(1), id(2)]);
    expect(next?.[0].lastMessage?.preview).toBe("latest");
    expect(next?.[0].lastCustomerMsgAt).toBe("2026-10-07T06:00:00.000Z");
  });

  it("ignores an older message arriving late (order is by created_at, not arrival)", () => {
    const list = [newer, older];
    const next = applyMessageToList(list, chatMessage({ id: id(501), conversation_id: id(2), created_at: "2026-10-07T01:00:00Z", body: "late" }));
    expect(next?.find((c) => c.id === id(2))?.lastMessage?.preview).toBe("new");
  });

  it("keeps system notes out of the preview", () => {
    const next = applyMessageToList([newer], chatMessage({ id: id(502), conversation_id: id(2), sender: "system", created_at: "2026-10-07T06:00:00Z", body: "Handed to team" }));
    expect(next?.[0].lastMessage?.preview).toBe("new");
  });

  it("asks for a refetch when the chat isn't loaded yet", () => {
    expect(applyMessageToList([older], chatMessage({ conversation_id: id(9) }))).toBeNull();
    expect(applyConversationChange([older], { id: id(9), tenant_id: TENANT, mode: "ai", status: "open", last_customer_msg_at: null })).toBeNull();
    expect(applyHandoffChange([older], { id: id(301), tenant_id: TENANT, conversation_id: id(9), trigger: "stuck", resolved_at: null })).toBeNull();
  });

  it("updates mode and the 24-hour window from a conversation change", () => {
    const next = applyConversationChange([older], { id: id(1), tenant_id: TENANT, mode: "human", status: "open", last_customer_msg_at: "2026-10-07T06:00:00.000Z" });
    expect(next?.[0]).toMatchObject({ mode: "human", lastCustomerMsgAt: "2026-10-07T06:00:00.000Z" });
  });

  it("opens and resolves handoffs", () => {
    const opened = applyHandoffChange([older], { id: id(301), tenant_id: TENANT, conversation_id: id(1), trigger: "complaint", resolved_at: null })!;
    expect(conversationTag(opened[0])).toBe("needs_human");
    const again = applyHandoffChange(opened, { id: id(301), tenant_id: TENANT, conversation_id: id(1), trigger: "complaint", resolved_at: null })!;
    expect(again[0].openHandoffs).toHaveLength(1);
    const resolved = applyHandoffChange(again, { id: id(301), tenant_id: TENANT, conversation_id: id(1), trigger: "complaint", resolved_at: "2026-10-07T06:10:00.000Z" })!;
    expect(conversationTag(resolved[0])).toBe("ai");
  });

  it("de-duplicates messages by id and sorts them by created_at", () => {
    const a = chatMessage({ id: id(1), created_at: "2026-10-07T04:00:00Z", body: "first" });
    const b = chatMessage({ id: id(2), created_at: "2026-10-07T05:00:00Z", body: "second" });
    let msgs = upsertMessage([], b);
    msgs = upsertMessage(msgs, a);
    msgs = upsertMessage(msgs, { ...b, deliveryStatus: "read" });
    expect(msgs.map((m) => m.body)).toEqual(["first", "second"]);
    expect(msgs[1].deliveryStatus).toBe("read");
  });
});

describe("times in the business's time zone", () => {
  it("formats the list time like the prototype", () => {
    expect(formatListTime("2026-10-07T04:12:00Z", NOW, TZ)).toBe("9:42 am");
    expect(formatListTime("2026-10-06T10:00:00Z", NOW, TZ)).toBe("Yesterday");
    expect(formatListTime("2026-10-05T10:00:00Z", NOW, TZ)).toBe("Mon");
    expect(formatListTime("2026-09-20T10:00:00Z", NOW, TZ)).toBe("20 Sept");
  });

  it("uses the business's calendar day, not UTC's", () => {
    // 19:00 UTC on the 6th is 00:30 on the 7th in Chennai: today, not yesterday.
    expect(formatListTime("2026-10-06T19:00:00Z", NOW, TZ)).toBe("12:30 am");
    expect(formatListTime("2026-10-06T19:00:00Z", NOW, "UTC")).toBe("Yesterday");
  });

  it("labels day chips and groups messages under them", () => {
    expect(dayChipLabel("2026-10-07T04:12:00Z", NOW, TZ)).toBe("TODAY");
    expect(dayChipLabel("2026-10-06T04:12:00Z", NOW, TZ)).toBe("YESTERDAY");
    expect(dayChipLabel("2026-10-04T04:12:00Z", NOW, TZ)).toBe("SUNDAY");
    const groups = groupByDay(
      [
        chatMessage({ id: id(1), created_at: "2026-10-06T04:00:00Z" }),
        chatMessage({ id: id(2), created_at: "2026-10-07T04:00:00Z" }),
        chatMessage({ id: id(3), created_at: "2026-10-07T05:00:00Z" }),
      ],
      NOW,
      TZ,
    );
    expect(groups.map((g) => [g.label, g.messages.length])).toEqual([["YESTERDAY", 1], ["TODAY", 2]]);
  });

  it("knows when the 24-hour window is open", () => {
    expect(isWindowOpen("2026-10-06T07:00:00Z", NOW)).toBe(true);
    expect(isWindowOpen("2026-10-06T06:00:00Z", NOW)).toBe(false);
    expect(isWindowOpen(null, NOW)).toBe(false);
    expect(lastWrotePhrase("2026-10-05T04:00:00Z", NOW, TZ)).toBe("on Monday");
  });
});

describe("reads", () => {
  it("reads conversations for the session's tenant only, with open handoffs and the latest non-system message", async () => {
    const { client, calls, table } = fakeClient({ data: [listRow()], error: null });
    const list = await fetchConversations(client, TENANT);
    expect(table()).toBe("conversations");
    expect(calls).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(calls).toContainEqual(["is", ["handoffs.resolved_at", null]]);
    expect(calls).toContainEqual(["neq", ["messages.sender", "system"]]);
    expect(calls).toContainEqual(["limit", [1, { referencedTable: "messages" }]]);
    expect(list.map((c) => c.id)).toEqual([id(1)]);
  });

  it("drops a row from another business even if one came back", async () => {
    const { client } = fakeClient({ data: [listRow(), listRow({ id: id(2), tenant_id: OTHER_TENANT })], error: null });
    expect((await fetchConversations(client, TENANT)).map((c) => c.id)).toEqual([id(1)]);
  });

  it("reads one named conversation for the session's tenant, so a link to a chat older than the newest page still opens", async () => {
    const { client, calls, table } = fakeClient({ data: [listRow({ id: id(7) })], error: null });
    const found = await fetchConversation(client, TENANT, id(7));
    expect(table()).toBe("conversations");
    expect(calls).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(calls).toContainEqual(["eq", ["id", id(7)]]);
    expect(calls).toContainEqual(["is", ["handoffs.resolved_at", null]]);
    expect(calls).toContainEqual(["neq", ["messages.sender", "system"]]);
    expect(found?.id).toBe(id(7));
  });

  it("finds nothing for an unknown id, and never returns another business's conversation", async () => {
    expect(await fetchConversation(fakeClient({ data: [], error: null }).client, TENANT, id(7))).toBeNull();
    expect(await fetchConversation(fakeClient({ data: null, error: null }).client, TENANT, id(7))).toBeNull();
    const other = fakeClient({ data: [listRow({ id: id(7), tenant_id: OTHER_TENANT })], error: null });
    expect(await fetchConversation(other.client, TENANT, id(7))).toBeNull();
    // A row that isn't the one asked for is not it either.
    expect(await fetchConversation(fakeClient({ data: [listRow({ id: id(8) })], error: null }).client, TENANT, id(7))).toBeNull();
  });

  it("passes database errors on and rejects a row of the wrong shape when reading one conversation", async () => {
    const pgError = { code: "42501", message: "permission denied", details: null, hint: null };
    await expect(fetchConversation(fakeClient({ data: null, error: pgError }).client, TENANT, id(7))).rejects.toBe(pgError);
    await expect(fetchConversation(fakeClient({ data: [{ id: "nope" }], error: null }).client, TENANT, id(7))).rejects.toBeInstanceOf(InboxDataError);
  });

  it("reads one chat's messages for the tenant, newest page first, shown oldest first", async () => {
    const rows = [
      messageRow({ id: id(2), created_at: "2026-10-07T05:00:00Z", body: "second" }),
      messageRow({ id: id(1), created_at: "2026-10-07T04:00:00Z", body: "first" }),
    ];
    const { client, calls, table } = fakeClient({ data: rows, error: null });
    const messages = await fetchMessages(client, TENANT, id(1));
    expect(table()).toBe("messages");
    expect(calls).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(calls).toContainEqual(["eq", ["conversation_id", id(1)]]);
    expect(messages.map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("passes database errors on and rejects rows of the wrong shape", async () => {
    const pgError = { code: "42501", message: "permission denied", details: null, hint: null };
    await expect(fetchConversations(fakeClient({ data: null, error: pgError }).client, TENANT)).rejects.toBe(pgError);
    await expect(fetchMessages(fakeClient({ data: [{ id: "nope" }], error: null }).client, TENANT, id(1))).rejects.toBeInstanceOf(InboxDataError);
  });

  it("treats no rows as an empty inbox", async () => {
    expect(await fetchConversations(fakeClient({ data: [], error: null }).client, TENANT)).toEqual([]);
  });
});

describe("display masking", () => {
  it("masks numbers for display", () => {
    expect(maskPhoneForDisplay("+919812345621")).toBe("+91 98xxx xxx21");
    expect(maskPhoneForDisplay("12345")).toBe("Hidden number");
  });
});

describe("overlapping reads", () => {
  it("uses only the newest read, so an older one finishing late can't overwrite it", () => {
    const reads = new ReadSequencer<string[]>();
    const first = reads.start();
    const second = reads.start();
    expect(reads.finish(second, ["new"])).toEqual(["new"]);
    expect(reads.finish(first, ["old"])).toBeNull();
    expect(reads.fail(first)).toBe(false);
  });

  it("replays live changes that arrived while the read was in flight", () => {
    const reads = new ReadSequencer<string[]>();
    reads.record((v) => [...v, "before any read"]); // nothing in flight: not kept
    const seq = reads.start();
    reads.record((v) => [...v, "live"]);
    expect(reads.finish(seq, ["snapshot"])).toEqual(["snapshot", "live"]);
    // The next read starts clean.
    const next = reads.start();
    expect(reads.finish(next, ["again"])).toEqual(["again"]);
  });

  it("drops pending changes when the newest read fails", () => {
    const reads = new ReadSequencer<string[]>();
    const seq = reads.start();
    reads.record((v) => [...v, "live"]);
    expect(reads.fail(seq)).toBe(true);
    const next = reads.start();
    expect(reads.finish(next, ["fresh"])).toEqual(["fresh"]);
  });

  it("keeps a live message when a chat read's snapshot predates it", () => {
    const reads = new ReadSequencer<ChatMessage[]>();
    const seq = reads.start();
    const live = chatMessage({ id: id(9), created_at: "2026-10-07T06:00:00Z", body: "arrived during the read" });
    reads.record((msgs) => upsertMessage(msgs, live));
    const snapshot = [chatMessage({ id: id(1), created_at: "2026-10-07T05:00:00Z", body: "older" })];
    expect(reads.finish(seq, snapshot)?.map((m) => m.body)).toEqual(["older", "arrived during the read"]);
  });
});

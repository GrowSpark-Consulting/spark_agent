import { describe, expect, it, vi } from "vitest";
import { fakeTables, type Row } from "../../test-support/fake-tables";
import type { SendOutcome } from "../../notify/send";
import { handleHandoffLink, type LinkDeps } from "./takeover";
import { signHandoffToken } from "./token";

// What a staff member's tap on an alert's button does (docs/handover.md, module 6; Raja, 11 Oct): the INBOX button takes the chat over in the dashboard,
// the OWN-NUMBER button (Growth, Pro and Trial) moves it to their own WhatsApp and tells the customer who will message them. Each link works once, for
// the person it names, for 24 hours; anything else gets a friendly page that points to the inbox, never an error screen.

const KEY = Buffer.alloc(32, 7).toString("base64");
const APP = "https://app.example.test";
const A = "e0000000-0000-4000-8000-00000000000a";
const B = "e0000000-0000-4000-8000-00000000000b";
const PRIYA = "f1000000-0000-4000-8000-000000000001";
const RAVI = "f1000000-0000-4000-8000-000000000002";
const HANDOFF = "a1000000-0000-4000-8000-000000000001";
const CONV = "c0000000-0000-4000-8000-0000000000c1";
const CONTACT = "b0000000-0000-4000-8000-0000000000b1";
const NOW = new Date("2026-10-11T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

interface Options {
  mode?: string;
  assigned?: string | null;
  handoff?: Partial<Row>;
  member?: Partial<Row> | null;
  ownNumber?: boolean;
  sendOutcome?: SendOutcome | Error;
  contact?: Row | null;
  language?: string | null;
  now?: Date;
}

function world(over: Options = {}) {
  const t = fakeTables({
    handoffs: [{ id: HANDOFF, tenant_id: A, conversation_id: CONV, trigger: "asked_human", priority: "high", picked_at: null, resolved_at: null, assigned_user_id: null, takeover_mode: null, ...over.handoff }],
    conversations: [{ id: CONV, tenant_id: A, contact_id: CONTACT, mode: over.mode ?? "human", assigned_user_id: over.assigned ?? null }],
    contacts: over.contact === null ? [] : [{ id: CONTACT, tenant_id: A, phone: "+919812345621", name: "Anand Kumar", language: over.language === undefined ? "en" : over.language, ...over.contact }],
    memberships: over.member === null ? [] : [{ tenant_id: A, user_id: PRIYA, role: "staff", whatsapp_phone: "+919876500001", takeover_pref: "ask", ...over.member }],
    tenants: [{ id: A, name: "Sunrise Homes", timezone: "Asia/Kolkata" }],
    messages: [],
    audit_logs: [],
  });
  const sent: { tenantId: string; kind: string; payload: { conversationId: string; text: string } }[] = [];
  const deps: LinkDeps = {
    db: t.db,
    env: { ENCRYPTION_KEY: KEY, NEXT_PUBLIC_APP_URL: APP },
    now: () => over.now ?? NOW,
    isEnabled: vi.fn(async () => over.ownNumber ?? true),
    userName: vi.fn(async (id: string) => (id === PRIYA ? "Priya" : id === RAVI ? "Ravi" : null)),
    send: vi.fn(async (tenantId, kind, payload) => {
      sent.push({ tenantId, kind, payload });
      if (over.sendOutcome instanceof Error) throw over.sendOutcome;
      return over.sendOutcome ?? { status: "sent" as const, messageId: "m", providerMsgId: "w", creditsCharged: 1, usedTemplate: false };
    }),
  };
  const link = (mode: string | null, claims = { tenantId: A, handoffId: HANDOFF, userId: PRIYA }, at: Date = NOW) => {
    const token = signHandoffToken(claims, { ENCRYPTION_KEY: KEY }, at);
    return { token, request: new Request(`https://api.example.test/h/${token}${mode === null ? "" : `?mode=${mode}`}`), params: { token } };
  };
  const open = (mode: string | null, claims?: { tenantId: string; handoffId: string; userId: string }, at?: Date) => {
    const l = link(mode, claims, at);
    return handleHandoffLink(l.request, l.params, deps);
  };
  return { ...t, deps, sent, link, open };
}

const body = async (res: Response) => (await res.text()).replace(/\s+/g, " ");

describe("the inbox button", () => {
  it("takes the chat over for the staff member, marks the handoff picked up by them, and opens the inbox on that chat", async () => {
    const w = world({ mode: "ai" });
    const res = await w.open("inbox");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}/dashboard/inbox?chat=${CONV}`);
    expect(w.tables.conversations[0]).toMatchObject({ mode: "human", assigned_user_id: PRIYA });
    expect(w.tables.handoffs[0]).toMatchObject({ picked_at: NOW.toISOString(), assigned_user_id: PRIYA, takeover_mode: "inbox" });
  });

  it("leaves a note in the chat, and audits who took it", async () => {
    const w = world({ mode: "ai" });
    await w.open("inbox");
    expect(w.tables.messages).toEqual([expect.objectContaining({ tenant_id: A, conversation_id: CONV, direction: "out", sender: "system", meta: { event: "takeover" } })]);
    expect(w.tables.audit_logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenant_id: A, actor: PRIYA, action: "conversation.mode_changed", entity_id: CONV, diff: { from: "ai", to: "human", via: "alert_link" } }),
        expect.objectContaining({ tenant_id: A, actor: PRIYA, action: "handoff.picked", entity_id: HANDOFF, diff: { takeover: "inbox" } }),
      ]),
    );
  });

  it("is the default when the link names no mode", async () => {
    const w = world({ mode: "ai" });
    expect((await w.open(null)).headers.get("location")).toContain("/dashboard/inbox");
    expect(w.tables.handoffs[0].takeover_mode).toBe("inbox");
  });

  it("a chat the AI already gave to a person (nobody assigned yet) is assigned to the staff member who tapped, with no second switch", async () => {
    const w = world({ mode: "human" });
    expect((await w.open("inbox")).status).toBe(302);
    expect(w.tables.conversations[0]).toMatchObject({ mode: "human", assigned_user_id: PRIYA });
    expect(w.tables.audit_logs.find((a) => a.action === "conversation.mode_changed")).toBeUndefined();
  });

  it("a chat a teammate already has is not taken from them: a friendly page, and nothing is changed", async () => {
    const w = world({ mode: "human", assigned: RAVI });
    const res = await w.open("inbox");
    expect(res.status).toBe(409);
    expect(await body(res)).toMatch(/teammate already has this chat/i);
    expect(w.tables.conversations[0]).toMatchObject({ assigned_user_id: RAVI });
    expect(w.tables.handoffs[0].picked_at).toBeNull();
  });

  it("a chat that is being handled from someone's own number cannot be taken over in the inbox", async () => {
    const w = world({ mode: "external", assigned: RAVI });
    const res = await w.open("inbox");
    expect(res.status).toBe(409);
    expect(await body(res)).toMatch(/own WhatsApp number/i);
  });
});

describe("the own-number button", () => {
  it("moves the chat to the staff member's own WhatsApp, and sends them to the customer with a greeting ready", async () => {
    const w = world({ mode: "ai" });
    const res = await w.open("own");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://wa.me/919812345621");
    expect(location.searchParams.get("text")).toBe("Hi Anand, this is Priya from Sunrise Homes. How can I help you?");
    expect(w.tables.conversations[0]).toMatchObject({ mode: "external", assigned_user_id: PRIYA });
    expect(w.tables.handoffs[0]).toMatchObject({ picked_at: NOW.toISOString(), assigned_user_id: PRIYA, takeover_mode: "own_number" });
  });

  it("tells the customer, as one AI reply (1 credit), who will message them and from which number, in their language", async () => {
    const w = world({ mode: "ai", language: "ta-en" });
    await w.open("own");
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ tenantId: A, kind: "ai_reply", payload: { conversationId: CONV } });
    expect(w.sent[0].payload.text).toContain("Priya");
    expect(w.sent[0].payload.text).toContain("Sunrise Homes");
    expect(w.sent[0].payload.text).toContain("+919876500001");
  });

  it("says so in English for a customer whose language is not known", async () => {
    const w = world({ mode: "ai", language: null });
    await w.open("own");
    expect(w.sent[0].payload.text).toBe("Priya from Sunrise Homes will message you from +919876500001 shortly.");
  });

  it("leaves a note in the chat, and audits it", async () => {
    const w = world({ mode: "ai" });
    await w.open("own");
    expect(w.tables.messages).toEqual([expect.objectContaining({ sender: "system", meta: { event: "own_number_takeover" } })]);
    expect(String(w.tables.messages[0].body)).toContain("Priya");
    expect(w.tables.audit_logs).toEqual(expect.arrayContaining([expect.objectContaining({ actor: PRIYA, action: "handoff.picked", diff: { takeover: "own_number" } })]));
  });

  it("still sends the staff member to the customer when the customer's notice could not be sent (outside the window, or no credits)", async () => {
    for (const sendOutcome of [{ status: "skipped", reason: "insufficient_credits" } as SendOutcome, { status: "skipped", reason: "outside_window" } as SendOutcome, new Error("down")]) {
      const w = world({ mode: "ai", sendOutcome });
      const res = await w.open("own");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("https://wa.me/919812345621");
      expect(w.tables.conversations[0].mode).toBe("external");
    }
  });

  it("is not on a plan without it: a friendly page that points to the inbox button, and nothing is changed", async () => {
    const w = world({ mode: "ai", ownNumber: false });
    const res = await w.open("own");
    expect(res.status).toBe(403);
    expect(await body(res)).toMatch(/is not part of your plan/i);
    expect(w.tables.conversations[0].mode).toBe("ai");
    expect(w.tables.handoffs[0].picked_at).toBeNull();
    expect(w.sent).toEqual([]);
  });

  it("is refused for a staff member who chose to reply in the inbox only, and for one with no WhatsApp number set", async () => {
    const inboxOnly = world({ mode: "ai", member: { takeover_pref: "inbox" } });
    const first = await inboxOnly.open("own");
    expect(first.status).toBe(403);
    expect(await body(first)).toMatch(/inbox/i);
    const noPhone = world({ mode: "ai", member: { whatsapp_phone: null } });
    const second = await noPhone.open("own");
    expect(second.status).toBe(403);
    expect(await body(second)).toMatch(/add your WhatsApp number/i);
    expect(inboxOnly.tables.conversations[0].mode).toBe("ai");
    expect(noPhone.tables.conversations[0].mode).toBe("ai");
  });

  it("is allowed for a staff member who chose own-number replies, and for one who is asked each time (the default)", async () => {
    for (const takeover_pref of ["own_number", "ask", null]) expect((await world({ mode: "ai", member: { takeover_pref } }).open("own")).status).toBe(302);
  });

  it("a chat that someone else already has is not taken", async () => {
    const w = world({ mode: "human", assigned: RAVI });
    expect((await w.open("own")).status).toBe(409);
    expect(w.tables.conversations[0]).toMatchObject({ mode: "human", assigned_user_id: RAVI });
    expect(w.sent).toEqual([]);
  });

  it("a customer who cannot be found is a friendly page, not a redirect to nowhere", async () => {
    const w = world({ mode: "ai", contact: null });
    expect((await w.open("own")).status).toBe(404);
  });
});

describe("a link that does not work", () => {
  it("used once is dead: the second tap, by the same person, gets a friendly page with a button to the inbox, and changes nothing", async () => {
    const w = world({ mode: "ai" });
    await w.open("inbox");
    const again = await w.open("inbox");
    expect(again.status).toBe(409);
    const html = await body(again);
    expect(html).toMatch(/already been used/i);
    expect(html).toContain(`href="${APP}/dashboard/inbox"`);
  });

  it("the other button of the same alert is dead too, once one was used: one takeover per handoff", async () => {
    const w = world({ mode: "ai" });
    await w.open("inbox");
    expect((await w.open("own")).status).toBe(409);
    expect(w.tables.conversations[0].mode).toBe("human");
  });

  it("two people tapping at the same moment: exactly one gets it", async () => {
    const w = world({ mode: "ai", member: undefined });
    w.tables.memberships.push({ tenant_id: A, user_id: RAVI, role: "admin", whatsapp_phone: "+919876500002", takeover_pref: "ask" });
    const [first, second] = await Promise.all([w.open("inbox"), w.open("inbox", { tenantId: A, handoffId: HANDOFF, userId: RAVI })]);
    expect([first.status, second.status].sort()).toEqual([302, 409]);
    expect(w.tables.handoffs[0].picked_at).not.toBeNull();
  });

  it("after 24 hours it has expired: a friendly page, the chat is not lost, nothing is changed", async () => {
    const w = world({ mode: "ai" });
    const l = w.link("inbox", undefined, new Date(NOW.getTime() - 24 * 3_600_000 - 1000));
    const res = await handleHandoffLink(l.request, l.params, w.deps);
    expect(res.status).toBe(410);
    const html = await body(res);
    expect(html).toMatch(/expired/i);
    expect(html).toContain(`href="${APP}/dashboard/inbox"`);
    expect(w.tables.conversations[0].mode).toBe("ai");
    expect(w.tables.handoffs[0].picked_at).toBeNull();
  });

  it.each(["", "abc", "a.b", "x".repeat(2000)])("a token that is not a token (%#) is the same friendly page", async (token) => {
    const w = world();
    const res = await handleHandoffLink(new Request(`https://api.example.test/h/${encodeURIComponent(token)}`), { token }, w.deps);
    expect(res.status).toBe(410);
    expect(await body(res)).toMatch(/expired|not valid/i);
  });

  it("a token changed to name another staff member does not work (the signature fails)", async () => {
    const w = world({ mode: "ai" });
    const [payload, mac] = w.link("inbox").token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), u: RAVI })).toString("base64url");
    const res = await handleHandoffLink(new Request(`https://api.example.test/h/${forged}.${mac}`), { token: `${forged}.${mac}` }, w.deps);
    expect(res.status).toBe(410);
    expect(w.tables.conversations[0].mode).toBe("ai");
  });

  it("a token for someone who is not a member of the business (any more) does not work", async () => {
    const w = world({ mode: "ai", member: null });
    const res = await w.open("inbox");
    expect(res.status).toBe(403);
    expect(w.tables.conversations[0].mode).toBe("ai");
    expect(w.tables.handoffs[0].picked_at).toBeNull();
  });

  it("a handoff of another business is never touched, even with a token that names this one's id", async () => {
    const w = world({ mode: "ai", handoff: { tenant_id: B } });
    const res = await w.open("inbox");
    expect(res.status).toBe(410);
    expect(w.tables.handoffs[0].picked_at).toBeNull();
    expect(w.tables.conversations[0].mode).toBe("ai");
  });

  it("a handoff that was already closed (the chat went back to the AI) is a friendly page, not a takeover", async () => {
    const w = world({ mode: "ai", handoff: { resolved_at: iso(NOW.getTime() - 1000) } });
    const res = await w.open("inbox");
    expect(res.status).toBe(409);
    expect(await body(res)).toMatch(/already been used|no longer waiting/i);
    expect(w.tables.conversations[0].mode).toBe("ai");
  });

  it("a mode that is neither inbox nor own is not a mode", async () => {
    const w = world({ mode: "ai" });
    expect((await w.open("delete-everything")).status).toBe(404);
    expect(w.tables.conversations[0].mode).toBe("ai");
  });
});

describe("what a page never shows, and how it is sent", () => {
  it("friendly pages carry no token, no number and no name, and are never cached or leaked through a referrer", async () => {
    const w = world({ mode: "ai" });
    await w.open("inbox");
    const l = w.link("inbox");
    const res = await handleHandoffLink(l.request, l.params, w.deps); // a different, unused token for a picked handoff
    const html = await res.text();
    expect(html).not.toContain(l.token);
    expect(html).not.toMatch(/9812345621|Anand|Priya/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("a redirect is never cached either", async () => {
    const w = world({ mode: "ai" });
    expect((await w.open("inbox")).headers.get("cache-control")).toBe("no-store");
  });

  it("logs hold no token, number or name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ mode: "ai" });
    const l = w.link("own");
    await handleHandoffLink(l.request, l.params, w.deps);
    const all = [...log.mock.calls, ...err.mock.calls].flat().join("\n");
    expect(all).not.toContain(l.token);
    expect(all).not.toMatch(/9812345621|9876500001|Anand/);
    log.mockRestore();
    err.mockRestore();
  });

  it("every read and write names the business from the signed token", async () => {
    const w = world({ mode: "ai" });
    await w.open("own");
    for (const call of w.calls) {
      const named = call.op === "insert" ? (call.payload as { tenant_id?: string }).tenant_id === A : call.filters.some((f) => (f.column === "tenant_id" || (call.table === "tenants" && f.column === "id")) && f.op === "eq");
      expect(named, `${call.table} ${call.op} is not scoped to the business`).toBe(true);
    }
  });
});

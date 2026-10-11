import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isEnabled } from "../../features/is-enabled";
import { serverEnv } from "../../lib/env";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { send, type NotifyPayload, type SendOutcome } from "../../notify/send";
import { friendlyPage, NOTICES, redirect, type Notice } from "./pages";
import { ownNumberGreeting, ownNumberNotice } from "./texts";
import { verifyHandoffToken } from "./token";

// GET /h/:token?mode=inbox|own (docs/handover.md, module 6; Raja, 11 Oct): what a staff member's tap on a button in an alert does.
//   inbox  the chat is theirs in the dashboard: mode human, assigned to them, the handoff picked up, a note in the chat, and the inbox opens on it
//   own    (Growth, Pro and Trial) the chat moves to their own WhatsApp: mode external, assigned to them, the customer is told who will message them and
//          from which number (one AI reply, 1 credit, best effort), and they are sent to wa.me with a greeting ready
// The link works ONCE (the first tap claims the handoff, `picked_at`, with a compare-and-set, so two people tapping together get one winner and the
// other button of the same alert dies with it), for the person it names, for 24 hours (token.ts). Anything it cannot do is a friendly page that points
// to the inbox (pages.ts), never an error screen, and changes nothing. The token is the only credential: the action is done AS the staff member it
// names, who must still be a member of the business. Every query names the business from the signed token. Service role.

const TAG = "[handoff-link]";
type Send = (tenantId: string, kind: "ai_reply", payload: NotifyPayload) => Promise<SendOutcome>;

export interface LinkDeps {
  db: SupabaseClient;
  env: { ENCRYPTION_KEY?: string; NEXT_PUBLIC_APP_URL: string };
  now: () => Date;
  /** isEnabled(tenantId, "handoff_own_number"): Growth, Pro and Trial. */
  isEnabled: (tenantId: string, feature: "handoff_own_number") => Promise<boolean>;
  /** The staff member's name as the customer will read it, or null. */
  userName: (userId: string) => Promise<string | null>;
  send: Send;
}

const defaults = (): LinkDeps => ({
  db: supabaseAdmin(),
  env: serverEnv(),
  now: () => new Date(),
  isEnabled: (tenantId, feature) => isEnabled(tenantId, feature),
  userName: async (userId) => {
    const { data, error } = await supabaseAdmin().auth.admin.getUserById(userId);
    if (error || !data.user) return null;
    const meta = data.user.user_metadata as Record<string, unknown> | undefined;
    const named = [meta?.full_name, meta?.name].find((v): v is string => typeof v === "string" && v.trim() !== "");
    return (named ?? data.user.email?.split("@")[0] ?? "").trim() || null;
  },
  send: (tenantId, kind, payload) => send(tenantId, kind, payload),
});

const HandoffRow = z.object({ conversation_id: z.string(), picked_at: z.string().nullable(), resolved_at: z.string().nullable() });
const MemberRow = z.object({ role: z.enum(["owner", "admin", "staff"]), whatsapp_phone: z.string().nullable(), takeover_pref: z.enum(["inbox", "own_number", "ask"]).nullable() });
const ConversationRow = z.object({ contact_id: z.string(), mode: z.enum(["ai", "human", "external"]), assigned_user_id: z.string().nullable() });
const ContactRow = z.object({ phone: z.string(), name: z.string().nullable(), language: z.string().nullable() });
const NameRow = z.object({ name: z.string() });
const Changed = z.object({ id: z.string() });

class Trouble extends Error {
  constructor(what: string, readonly code: string | undefined) {
    super(what);
  }
}

/** A read or a write: its rows, or a Trouble carrying the database's code only (a row can hold a customer's words). */
function rowsOf<S extends z.ZodType>(schema: S, result: { data: unknown; error: { code?: string } | null }, what: string): z.infer<S>[] {
  if (result.error) throw new Trouble(what, result.error.code);
  return (Array.isArray(result.data) ? result.data : []).flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

const NOTES = {
  inbox: { body: "A team member took over this chat. The AI won’t reply.", event: "takeover" },
  own: { event: "own_number_takeover" },
} as const;

export async function handleHandoffLink(request: Request, params: { token: string }, deps: LinkDeps = defaults()): Promise<Response> {
  const inboxUrl = `${deps.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/dashboard/inbox`;
  const page = (notice: Notice) => friendlyPage(notice, inboxUrl);

  const mode = new URL(request.url).searchParams.get("mode") ?? "inbox";
  if (mode !== "inbox" && mode !== "own") return page(NOTICES.badLink);

  const checked = verifyHandoffToken(params.token, deps.env, deps.now());
  if (checked.status !== "ok") return page(NOTICES.expired); // changed, made elsewhere, or 24 hours old: one friendly page for all
  const { tenantId, handoffId, userId } = checked.claims;

  try {
    const { db } = deps;
    const [handoffs, members] = await Promise.all([
      db.from("handoffs").select("conversation_id, picked_at, resolved_at").eq("tenant_id", tenantId).eq("id", handoffId).limit(1),
      db.from("memberships").select("role, whatsapp_phone, takeover_pref").eq("tenant_id", tenantId).eq("user_id", userId).limit(1),
    ]);
    const [handoff] = rowsOf(HandoffRow, handoffs, "the handoff");
    const [member] = rowsOf(MemberRow, members, "the team member");
    if (!handoff) return page(NOTICES.expired);
    if (!member) return page(NOTICES.notMember);
    if (handoff.picked_at || handoff.resolved_at) return page(NOTICES.used);

    const [chats] = [await db.from("conversations").select("contact_id, mode, assigned_user_id").eq("tenant_id", tenantId).eq("id", handoff.conversation_id).limit(1)];
    const [conversation] = rowsOf(ConversationRow, chats, "the chat");
    if (!conversation) return page(NOTICES.expired);
    if (conversation.mode === "external") return page(NOTICES.external);
    if (conversation.assigned_user_id !== null && conversation.assigned_user_id !== userId) return page(NOTICES.teammate);

    if (mode === "own") {
      if (!(await deps.isEnabled(tenantId, "handoff_own_number"))) return page(NOTICES.plan);
      if (member.takeover_pref === "inbox") return page(NOTICES.inboxOnly);
      if (!member.whatsapp_phone) return page(NOTICES.noPhone);
    }

    const contacts = await db.from("contacts").select("phone, name, language").eq("tenant_id", tenantId).eq("id", conversation.contact_id).limit(1);
    const [contact] = rowsOf(ContactRow, contacts, "the customer");
    if (mode === "own" && !contact) return page(NOTICES.noCustomer);

    // The first tap claims the handoff. Compare-and-set: of two taps at the same moment only one finds it unclaimed.
    const claimed = await db
      .from("handoffs")
      .update({ picked_at: deps.now().toISOString(), assigned_user_id: userId, takeover_mode: mode === "own" ? "own_number" : "inbox" })
      .eq("tenant_id", tenantId)
      .eq("id", handoffId)
      .is("picked_at", null)
      .is("resolved_at", null)
      .select("id");
    if (rowsOf(Changed, claimed, "the claim").length === 0) return page(NOTICES.used);

    // Then the chat, again compare-and-set on what was read: if a teammate or the AI changed it meanwhile, nothing is overwritten and the claim is undone.
    const target = mode === "own" ? "external" : "human";
    let switching = db.from("conversations").update({ mode: target, assigned_user_id: userId }).eq("tenant_id", tenantId).eq("id", handoff.conversation_id).eq("mode", conversation.mode);
    switching = conversation.assigned_user_id === null ? switching.is("assigned_user_id", null) : switching.eq("assigned_user_id", userId);
    const switched = await switching.select("id");
    if (rowsOf(Changed, switched, "the chat switch").length === 0) {
      await db.from("handoffs").update({ picked_at: null, assigned_user_id: null, takeover_mode: null }).eq("tenant_id", tenantId).eq("id", handoffId).eq("assigned_user_id", userId);
      return page(NOTICES.teammate);
    }

    // The switch is what matters; what follows is best effort and never undoes it.
    const name = (await deps.userName(userId).catch(() => null)) ?? "A team member";
    const business = rowsOf(NameRow, await db.from("tenants").select("name").eq("id", tenantId).limit(1), "the business")[0]?.name ?? "the business";
    const note = mode === "own" ? `${name} is handling this chat from their own WhatsApp number. The AI won’t reply.` : NOTES.inbox.body;
    await db.from("messages").insert({ tenant_id: tenantId, conversation_id: handoff.conversation_id, direction: "out", sender: "system", body: note, meta: { event: mode === "own" ? NOTES.own.event : NOTES.inbox.event } });
    if (conversation.mode !== target) {
      await db.from("audit_logs").insert({ tenant_id: tenantId, actor: userId, action: "conversation.mode_changed", entity: "conversation", entity_id: handoff.conversation_id, diff: { from: conversation.mode, to: target, via: "alert_link" } });
    }
    await db.from("audit_logs").insert({ tenant_id: tenantId, actor: userId, action: "handoff.picked", entity: "handoff", entity_id: handoffId, diff: { takeover: mode === "own" ? "own_number" : "inbox" } });

    if (mode === "inbox") return redirect(`${inboxUrl}?chat=${handoff.conversation_id}`);

    // Own number: the customer is told who will message them, from which number (one AI reply, 1 credit). Best effort: a customer outside the 24-hour
    // window, or a business out of credits, is simply not told, and the staff member is sent to them all the same.
    const staffPhone = member.whatsapp_phone ?? "";
    try {
      await deps.send(tenantId, "ai_reply", { conversationId: handoff.conversation_id, text: ownNumberNotice(contact.language, { name, business, phone: staffPhone }) });
    } catch {
      console.error(`${TAG} the customer could not be told (business ${tenantId})`);
    }
    const customerDigits = contact.phone.replace(/\D/g, "");
    return redirect(`https://wa.me/${customerDigits}?text=${encodeURIComponent(ownNumberGreeting(contact.language, { name, business }, contact.name))}`);
  } catch (error) {
    // The class and the database's code only: never a number, a name or a word of the chat.
    console.error(`${TAG} the link could not be used (${error instanceof Trouble ? `${error.message}, database error ${error.code ?? "none"}` : error instanceof Error ? error.name : "unknown"}; business ${tenantId})`);
    return page(NOTICES.trouble);
  }
}

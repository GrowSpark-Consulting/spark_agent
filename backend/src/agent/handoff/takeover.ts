import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isEnabled } from "../../features/is-enabled";
import { serverEnv } from "../../lib/env";
import { inngest } from "../../inngest/client";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { send, type NotifyPayload, type SendOutcome } from "../../notify/send";
import { friendlyPage, NOTICES, redirect, type Notice } from "./pages";
import { lookupStaffName } from "./staff-name";
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
  /** The staff member's first name as the customer will read it, or null (the wording then names the business: texts.ts). */
  userName: (userId: string) => Promise<string | null>;
  send: Send;
  /** Tells the rest of the system (Dev 2's outcome question, 4 hours later) that a chat went to a staff member's own number. Ids only. */
  sendEvent: (event: { id: string; name: string; data: Record<string, string> }) => Promise<unknown>;
}

const defaults = (): LinkDeps => ({
  db: supabaseAdmin(),
  env: serverEnv(),
  now: () => new Date(),
  isEnabled: (tenantId, feature) => isEnabled(tenantId, feature),
  userName: lookupStaffName,
  send: (tenantId, kind, payload) => send(tenantId, kind, payload),
  sendEvent: (event) => inngest.send(event),
});

const HandoffRow = z.object({ conversation_id: z.string(), picked_at: z.string().nullable(), resolved_at: z.string().nullable(), assigned_user_id: z.string().nullable() });
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

/** The chat may or may not have been switched, and it could not be looked at again: the claim is kept, and the staff member is told to check the inbox. */
class Unconfirmed extends Error {}

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
      db.from("handoffs").select("conversation_id, picked_at, resolved_at, assigned_user_id").eq("tenant_id", tenantId).eq("id", handoffId).limit(1),
      db.from("memberships").select("role, whatsapp_phone, takeover_pref").eq("tenant_id", tenantId).eq("user_id", userId).limit(1),
    ]);
    const [handoff] = rowsOf(HandoffRow, handoffs, "the handoff");
    const [member] = rowsOf(MemberRow, members, "the team member");
    if (!handoff) return page(NOTICES.expired);
    if (!member) return page(NOTICES.notMember);
    if (handoff.picked_at && !handoff.resolved_at && handoff.assigned_user_id === userId) return page(NOTICES.usedByYou);
    if (handoff.picked_at || handoff.resolved_at) return page(NOTICES.used);

    const readChat = async () => rowsOf(ConversationRow, await db.from("conversations").select("contact_id, mode, assigned_user_id").eq("tenant_id", tenantId).eq("id", handoff.conversation_id).limit(1), "the chat")[0];
    const conversation = await readChat();
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
    // The claim is also given back when the switch fails, but only when the chat is seen not to have been switched: a dropped connection can lose the answer and not the write.
    const target = mode === "own" ? "external" : "human";
    const release = async () => {
      try {
        const released = await db.from("handoffs").update({ picked_at: null, assigned_user_id: null, takeover_mode: null }).eq("tenant_id", tenantId).eq("id", handoffId).eq("assigned_user_id", userId);
        if (released.error) throw new Trouble("the claim", released.error.code);
      } catch {
        throw new Unconfirmed();
      }
    };
    let switchedRows: number;
    try {
      let switching = db.from("conversations").update({ mode: target, assigned_user_id: userId }).eq("tenant_id", tenantId).eq("id", handoff.conversation_id).eq("mode", conversation.mode);
      switching = conversation.assigned_user_id === null ? switching.is("assigned_user_id", null) : switching.eq("assigned_user_id", userId);
      switchedRows = rowsOf(Changed, await switching.select("id"), "the chat switch").length;
    } catch (failure) {
      const now = await readChat().catch(() => "unknown" as const);
      if (now === "unknown") throw new Unconfirmed();
      if (now?.mode === target && now.assigned_user_id === userId) switchedRows = 1; // it had gone through
      else {
        await release();
        throw failure;
      }
    }
    if (switchedRows === 0) {
      await release();
      return page(NOTICES.teammate);
    }

    // The switch is what matters; everything after it is best effort and never undoes it or hides it.
    const soft = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await run();
      } catch (failure) {
        console.error(`${TAG} ${what} failed (${failure instanceof Trouble ? `database error ${failure.code ?? "none"}` : "unexpected error"}; business ${tenantId})`);
        return fallback;
      }
    };
    // A write that did not go through is logged with the database's code only, never a row, a number or a name.
    const save = async (what: string, write: PromiseLike<{ error: { code?: string } | null }>) => {
      try {
        const saved = await write;
        if (saved.error) console.error(`${TAG} ${what} was not saved (database error ${saved.error.code ?? "none"}; business ${tenantId})`);
      } catch {
        console.error(`${TAG} ${what} was not saved (the connection failed; business ${tenantId})`);
      }
    };

    const name = await deps.userName(userId).catch(() => null);
    const business = (await soft("the business name", async () => rowsOf(NameRow, await db.from("tenants").select("name").eq("id", tenantId).limit(1), "the business")[0]?.name, undefined)) ?? "the business";
    const note = mode === "own" ? `${name ?? "A team member"} is handling this chat from their own WhatsApp number. The AI won’t reply.` : NOTES.inbox.body;
    await save("the note in the chat", db.from("messages").insert({ tenant_id: tenantId, conversation_id: handoff.conversation_id, direction: "out", sender: "system", body: note, meta: { event: mode === "own" ? NOTES.own.event : NOTES.inbox.event } }));
    if (conversation.mode !== target) {
      await save("the mode audit row", db.from("audit_logs").insert({ tenant_id: tenantId, actor: userId, action: "conversation.mode_changed", entity: "conversation", entity_id: handoff.conversation_id, diff: { from: conversation.mode, to: target, via: "alert_link" } }));
    }
    await save("the takeover audit row", db.from("audit_logs").insert({ tenant_id: tenantId, actor: userId, action: "handoff.picked", entity: "handoff", entity_id: handoffId, diff: { takeover: mode === "own" ? "own_number" : "inbox" } }));

    if (mode === "inbox") return redirect(`${inboxUrl}?chat=${handoff.conversation_id}`);

    // Dev 2's job asks the staff member how it went after a while. Best effort: the takeover has happened either way.
    await deps.sendEvent({ id: `handoff_own_number:${handoffId}`, name: "handoff.own_number", data: { tenantId, handoffId } }).catch(() => console.error(`${TAG} the own-number event could not be sent (business ${tenantId})`));

    // Own number: the customer is told who will message them, from which number (one AI reply, 1 credit). Best effort: a customer outside the 24-hour
    // window, or a business out of credits, is simply not told, and the staff member is sent to them all the same.
    const staffPhone = member.whatsapp_phone ?? "";
    try {
      await deps.send(tenantId, "ai_reply", { conversationId: handoff.conversation_id, text: ownNumberNotice(contact.language, { name, business, phone: staffPhone }), idempotencyKey: `own_number_notice:${handoffId}` });
    } catch {
      console.error(`${TAG} the customer could not be told (business ${tenantId})`);
    }
    const customerDigits = contact.phone.replace(/\D/g, "");
    return redirect(`https://wa.me/${customerDigits}?text=${encodeURIComponent(ownNumberGreeting(contact.language, { name, business }, contact.name))}`);
  } catch (error) {
    if (error instanceof Unconfirmed) {
      console.error(`${TAG} the takeover could not be confirmed (business ${tenantId})`);
      return page(NOTICES.unsure);
    }
    // The class and the database's code only: never a number, a name or a word of the chat.
    console.error(`${TAG} the link could not be used (${error instanceof Trouble ? `${error.message}, database error ${error.code ?? "none"}` : error instanceof Error ? error.name : "unknown"}; business ${tenantId})`);
    return page(NOTICES.trouble);
  }
}

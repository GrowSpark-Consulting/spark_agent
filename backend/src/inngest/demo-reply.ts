import { z } from "zod";
import { demoDb } from "../channels/whatsapp/demo/db";
import { replyText, type MenuEntry } from "../channels/whatsapp/demo/text";
import { serverEnv } from "../lib/env";
import { send, type NotifyPayload, type SendOutcome } from "../notify/send";
import { inngest } from "./client";

// demo-reply (Day 6, PR 1b): what a visitor to the shared demo number is told when nothing could be routed: the industry menu, "invalid or expired code", the
// daily limit notice, or the used-trial refusal. The webhook stores the visitor's message with the front desk (the business that owns the number's connection,
// which answers on its own row) and starts this with ids only. The answer is one free `system_notice` through notify.send (free text, inside the 24 hours the
// visitor just opened), in the visitor's language. It is named by the visitor's message, so a retry or a redelivery never sends it twice. The Tamil and
// Tanglish wording is a machine draft awaiting a native speaker (channels/whatsapp/demo/text.ts).

export const DEMO_REPLY_EVENT = "whatsapp/demo.reply";

const DemoReplyEvent = z.object({
  tenantId: z.guid(),
  conversationId: z.guid(),
  messageId: z.guid(),
  kind: z.enum(["menu", "bad_code", "limit", "trial_taken"]),
  lang: z.enum(["en", "ta", "tanglish"]),
});

export interface DemoReplyDeps {
  menu: () => Promise<MenuEntry[]>;
  appUrl: () => string;
  send: (tenantId: string, kind: "system_notice", payload: NotifyPayload) => Promise<SendOutcome>;
}

const defaults = (): DemoReplyDeps => ({
  menu: () => demoDb().menu(),
  appUrl: () => serverEnv().NEXT_PUBLIC_APP_URL,
  send: (tenantId, kind, payload) => send(tenantId, kind, payload),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export type DemoReplyResult = { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; code: string };

export async function handleDemoReply({ event, step }: { event: { data: unknown }; step: Step }, deps: DemoReplyDeps = defaults()): Promise<DemoReplyResult> {
  const e = DemoReplyEvent.parse(event.data);
  const menu = e.kind === "menu" || e.kind === "bad_code" ? await step.run("menu", () => deps.menu()) : [];
  const text = replyText(e.kind, e.lang, menu, deps.appUrl());
  return step.run("send", async (): Promise<DemoReplyResult> => {
    const outcome = await deps.send(e.tenantId, "system_notice", { conversationId: e.conversationId, text, idempotencyKey: `demo_reply:${e.messageId}` });
    if (outcome.status === "sent") return { status: "sent" };
    if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
    // Throwing makes Inngest retry this step; never when WhatsApp may already have delivered it. The key makes a retry safe.
    if (outcome.error.retryable && !outcome.error.outcomeUnknown) throw new Error(`demo reply not sent (${outcome.error.code}), will retry`);
    return { status: "failed", code: outcome.error.code };
  });
}

export const demoReply = inngest.createFunction({ id: "demo-reply", triggers: [{ event: DEMO_REPLY_EVENT }], retries: 3 }, (ctx) =>
  handleDemoReply({ event: ctx.event, step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> } }),
);

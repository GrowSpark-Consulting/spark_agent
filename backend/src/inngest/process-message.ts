import { tellCustomerTeamIsHandling } from "../agent/handoff/external-notice";
import { MESSAGE_RECEIVED_EVENT, MessageReceived } from "../agent/pipeline/events";
import { answerRunThatGaveUp } from "../agent/pipeline/give-up";
import { runTurn } from "../agent/pipeline/process-message";
import { replyTurn } from "../agent/pipeline/reply";
import { stopCheck, stopCheckAfterGate } from "../agent/pipeline/stop";
import { replyDeps, understandDeps } from "../agent/pipeline/runtime";
import { createPipelineStore } from "../agent/pipeline/store";
import { turnClock } from "../agent/pipeline/turn-deadline";
import { understandTurn } from "../agent/pipeline/understand";
import { isEnabled } from "../features/is-enabled";
import { inngest } from "./client";

// The message pipeline (docs/handover.md: `process-message`, trigger `whatsapp/message.received`). The work is
// in agent/pipeline/process-message.ts; this wires it to Inngest.
//
// - One conversation at a time (concurrency key = conversationId), so two quick messages from one customer are
//   handled in order, never in parallel.
// - Messages that arrive within 3 seconds of each other start ONE run (debounce on the conversation, and no
//   longer than 15 seconds after the first). The debounce keeps only the LAST event, so the event is only a place
//   to start looking: the run collects the customer's unanswered messages itself and answers them together.
// - Every stage is a step: a failure retries that stage (3 retries) and never repeats what finished.
//
// The pipeline: resolve, batch, lead and gate (steps 2 and 3), the STOP check, understand the message and search the knowledge base
// (step 4), then reply and send (step 7 and the send): ONE reply per turn, through notify.send, recorded as answered
// in the same step. The decide step (Day 3) will sit between 4 and 7; until then the action is fixed: answer from the
// knowledge base's facts, or a safe line. Every way the run can end has an answer for the customer (plan.ts).
//
// One clock for the whole turn: the first step records when it began, and every invocation works out what is left of
// the 25-second hard stop (turn-deadline.ts); the model calls stop when it passes and the customer gets the safe line.
//
// A run that still fails after its retries: `onFailure` leaves a line (ids only) and, if the customer's messages are
// still unanswered and the chat is still the assistant's, sends one safe line (give-up.ts), so nobody is left in
// silence. A sweep for messages nobody answered, like kb-sweep does for documents, is still the follow-up for a
// failure that could not even do that.
export const processMessage = inngest.createFunction(
  {
    id: "process-message",
    triggers: [{ event: MESSAGE_RECEIVED_EVENT }],
    concurrency: { key: "event.data.conversationId", limit: 1 },
    debounce: { key: "event.data.conversationId", period: "3s", timeout: "15s" },
    retries: 3,
    onFailure: async ({ event, error }) => {
      const original = MessageReceived.safeParse((event.data.event as { data?: unknown } | undefined)?.data);
      // Ids and the kind of error only: no message text, no phone number, nothing the database said.
      console.error(`[pipeline] gave up after its retries${original.success ? ` on message ${original.data.messageId}` : ""} (${error.name})`);
      if (original.success) console.log(`[pipeline] safe line after giving up: ${await answerRunThatGaveUp(original.data)}`);
    },
  },
  async ({ event, step }) => {
    // step.run types its result as the JSON round trip of what the function returns; the results here are plain JSON already.
    const steps = { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> };
    // The turn's clock starts here (a step, so every later invocation of this function knows when it began).
    const startedAt = await steps.run("started", async () => Date.now());
    const store = createPipelineStore();
    const turn = await runTurn(steps, event.data, { store, isEnabled });
    // A status and a reason only: no ids, no message text, no phone number.
    if (turn.status !== "ready") {
      console.log(`[pipeline] ${turn.status} (${turn.reason})`);
      // A chat a person has, or one with the assistant switched off, still honours STOP: an opt-out never depends on a toggle.
      if (turn.status === "gated_off" && (turn.reason === "not_ai_mode" || turn.reason === "feature_off")) {
        const ids = MessageReceived.safeParse(event.data);
        if (ids.success) {
          const stop = await stopCheckAfterGate(steps, ids.data, replyDeps(store));
          if (stop.status === "opted_out") console.log(`[pipeline] opted out while gated off (confirmation ${stop.confirmation})`);
          // A chat a team member handles from their own number: the customer hears so, at most every 30 minutes (agent/handoff/external-notice.ts).
          else if (turn.reason === "not_ai_mode") {
            const told = await step.run("external-notice", () => tellCustomerTeamIsHandling(ids.data));
            console.log(`[pipeline] external notice: ${told.status === "told" ? "told" : told.reason}`);
          }
        }
      }
      return turn;
    }
    // STOP first: a customer who asks to stop is opted out and is not read, answered or updated any further.
    const stop = await stopCheck(steps, turn.turn, replyDeps(store));
    if (stop.status === "opted_out") {
      console.log(`[pipeline] opted out (confirmation ${stop.confirmation})`);
      return { status: "opted_out" };
    }
    const understood = await understandTurn(steps, turn.turn, understandDeps(store, turnClock(startedAt).signal));
    console.log(
      `[pipeline] ${understood.status}${understood.status === "fallback" ? ` (${understood.reason})` : ""}` +
        (understood.status === "understood" ? ` (${understood.summary.intent}; search ${understood.retrieval.outcome})` : ""),
    );
    const replied = await replyTurn(steps, turn.turn, understood, startedAt, replyDeps(store));
    // Case names and statuses only: no ids, no message text, no phone number. What happened is in the database.
    console.log(`[pipeline] replied: ${replied.case}; ${replied.reply.status}${replied.handoff ? `; handoff ${replied.handoff.trigger}` : ""}`);
    return { status: understood.status, reply: replied.reply.status };
  },
);

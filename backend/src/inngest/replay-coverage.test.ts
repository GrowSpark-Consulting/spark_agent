import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { functions } from "./functions";

// Exit test 1 (9-day plan, Day 7): "Replaying any webhook or job event twice changes nothing." Every Inngest function and both webhooks
// name the tests that prove it, and this file checks that each named test still exists. A new function fails here until its replay is
// proved. The proofs take one of three forms:
//   * keys: a second run sends under the same idempotency keys, and notify.send keeps one message per key (the sink, below);
//   * claims: the database hands each piece of work to one run (claim_trial_notice, settle_payment, a conditional update);
//   * nothing to repeat: the work is read-only, or a second run finds it done.
// Tests named "replay: ..." were written for this; the others already proved it in their own words.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface Proof {
  /** Repo-relative path of the test file. */
  file: string;
  /** Text that appears in the test's name (or, for a function with no side effects, in its source). */
  test: string;
}

/** The sink most keys rely on: a repeated key sends, charges and records nothing. */
const SINK: Proof = { file: "backend/src/notify/send.test.ts", test: "returns the first send for a repeat, without sending, charging or checking toggles again" };

const INNGEST = (name: string, test: string): Proof => ({ file: `backend/src/inngest/${name}.test.ts`, test });

const PROOFS: Record<string, Proof[]> = {
  "system-ping": [{ file: "backend/src/inngest/ping.ts", test: 'step.run("pong", () => ({ pong: true }))' }],
  "release-holds": [{ file: "supabase/tests/booking.test.sql", test: "a second run (a replay of the minute) expires nothing more" }],
  "kb-ingest": [
    { file: "backend/src/kb/ingest.test.ts", test: "does nothing the second time the same event arrives: a ready document is left alone" },
    { file: "backend/src/kb/ingest.test.ts", test: "replaces the chunks of an earlier attempt instead of adding to them" },
  ],
  "kb-sweep": [{ file: "backend/src/kb/store.test.ts", test: "fails the documents still processing after the cutoff" }],
  "process-message": [
    { file: "backend/src/agent/pipeline/whole-turn-matrix.test.ts", test: "a second run of the function for the same event finds the message answered and does nothing" },
    { file: "backend/src/agent/pipeline/whole-turn-matrix.test.ts", test: "delivered twice by the queue (no dedupe): two runs, one reply" },
  ],
  "handoff-alert": [INNGEST("handoff-alert", "replay: the same event twice alerts each member under the same key"), SINK],
  "booking-reminders": [INNGEST("booking-reminders", "replay: the same event twice sends under the same keys"), SINK],
  "handoff-sla": [INNGEST("handoff-sla", "replay: the same event twice escalates to each owner under the same key"), SINK],
  "post-visit": [INNGEST("post-visit", "replay: the same event twice sends and alerts under the same keys"), SINK],
  "lead-nudges": [
    INNGEST("lead-nudges", "replay: the same event twice nudges under the same keys and moves the same lead"),
    { file: "backend/src/leads/nudges.test.ts", test: "leaves a lead that moved on meanwhile alone" },
    SINK,
  ],
  "google-calendar-sync": [
    INNGEST("google-calendar-sync", "replay: the same event twice asks Google for the same booking's fixed event"),
    { file: "backend/src/booking/google-sync.test.ts", test: "treats Google's 'that id exists' as done, so a retry adds nothing twice" },
    { file: "backend/src/booking/google-sync.test.ts", test: "is done when the event is already gone" },
  ],
  "noshow-rebooking": [INNGEST("noshow-rebooking", "replay: the same event twice offers under the same key"), SINK],
  "daily-agenda": [INNGEST("daily-agenda", "replay: the same tick twice sends each owner's agenda under the same key"), SINK],
  "own-number-outcome": [INNGEST("own-number-outcome", "replay: the same event twice asks under the same key"), SINK],
  "phone-reply-return": [
    INNGEST("phone-reply-return", "a second run finds the chat already with the AI, and does nothing"),
    INNGEST("phone-reply-return", "two runs at the same moment cannot both return it"),
  ],
  "credit-alerts": [INNGEST("credit-alerts", "replay: the same event twice alerts each owner under the same key"), SINK],
  "event-alerts": [INNGEST("event-alerts", "replay: the same event twice alerts under the same keys"), SINK],
  "connection-health": [INNGEST("connection-health", "replay: the same sweep twice starts the same events")],
  "connection-health-check": [INNGEST("connection-health", "replay: the same check twice reports the same failure under the same key")],
  "token-expiry": [
    INNGEST("token-expiry", "replay: the same run twice warns about the same connections and expiry dates"),
    { file: "backend/src/channels/whatsapp/connect/token-expiry.test.ts", test: "the same date is never warned twice" },
  ],
  "billing-renewals": [
    { file: "supabase/tests/renewals.test.sql", test: "asking again for the same period returns the same payment" },
    { file: "supabase/tests/renewals.test.sql", test: "the notice goes once a period" },
    { file: "backend/src/billing/renewals.test.ts", test: "never charges a renewal already in flight" },
    { file: "supabase/tests/payments.test.sql", test: "the same success again (webhook after the return) applies nothing" },
  ],
  "trial-lifecycle": [INNGEST("trial-lifecycle", "replay: the same event in another run finds day 0 claimed and sends nothing")],
  "trial-lifecycle-sweep": [INNGEST("trial-lifecycle", "a repeat run sends nothing another run already claimed")],
  "unpaid-trial-cleanup": [
    INNGEST("unpaid-trial-cleanup", "replay: the same tick twice warns under the same keys and finds the deleted business gone, deleting nothing twice"),
    { file: "supabase/tests/unpaid_trial_deletion.test.sql", test: "a retry after it went changes nothing" },
    SINK,
  ],
  "demo-reply": [INNGEST("demo-reply", "replay: the same event twice answers under the same key"), SINK],
  // Sends nothing: a message that already has its file is left alone, and the upload is an overwrite of a fixed path.
  "media-download": [
    INNGEST("media-download", "replay: the same event twice asks for the same message both times"),
    { file: "backend/src/media/download.test.ts", test: "replay: the same event twice, the second run finding the first one's record, saves one file at one path" },
    { file: "backend/src/media/download.test.ts", test: "a message that already has its file does nothing: no Graph call, no upload, no write" },
  ],
  // Claims: each delivery is handed to one run and recorded once by it; a receiver dedupes a resend on the event id.
  "outbound-webhooks": [
    INNGEST("outbound-webhooks", "replay: the same run replayed claims nothing new and sends nothing again"),
    { file: "supabase/tests/outbound_webhooks.test.sql", test: "and nothing is handed out twice" },
    { file: "supabase/tests/outbound_webhooks.test.sql", test: "recording it again changes nothing" },
    { file: "backend/src/outbound-webhooks/deliver.test.ts", test: "replay: a run that no longer holds the delivery records nothing (null)" },
  ],
};

const WEBHOOKS: Record<string, Proof[]> = {
  // Meta's webhook: the message is stored once (provider id) and its event has a fixed id; even delivered twice, one reply.
  "POST /api/webhooks/whatsapp": [
    { file: "backend/src/agent/pipeline/whole-turn-matrix.test.ts", test: "Inngest drops the second event: one message stored, one run, one reply" },
    { file: "backend/src/agent/pipeline/whole-turn-matrix.test.ts", test: "Inngest delivers both anyway: two runs, the second finds it answered, one reply" },
  ],
  // PayU's webhook (and its return URL): only verify_payment is trusted, and settle_payment applies each payment once.
  "POST /api/webhooks/payu": [
    { file: "supabase/tests/payments.test.sql", test: "the same success again (webhook after the return) applies nothing" },
    { file: "supabase/tests/payments.test.sql", test: "the pack is never granted twice" },
    { file: "backend/src/billing/checkout.test.ts", test: "does not ask PayU about a payment that is final, or one that isn't ours" },
  ],
};

/**
 * Where a replay is NOT yet safe, pinned by a test that passes while the gap exists; remove the entry when the gap is closed. The crash
 * after WhatsApp accepted a reply and before notify.send recorded it was closed on Day 7 by claiming the send first (0045, below), and
 * the failure handler now reads that claim too (notify_attempts), so it adds no safe line after a reply that went. None remain.
 */
const KNOWN_GAPS: Proof[] = [];

/** The claim that makes a keyed send go at most once, even when its process dies after WhatsApp accepted it (0045). */
const CLAIM: Proof[] = [
  { file: "backend/src/agent/pipeline/whole-turn-matrix.test.ts", test: "the retry finds the claim and does not send again, so the reply goes ONCE" },
  { file: "backend/src/notify/send.test.ts", test: "an earlier attempt that never recorded or released its claim: nothing is sent or charged, and the outcome is unknown" },
  { file: "supabase/tests/notify_attempts.test.sql", test: "a repeat while it is claimed and not recorded (the attempt died, or its record failed) may not send" },
];

const contents = new Map<string, string>();
const read = (file: string) => {
  if (!contents.has(file)) contents.set(file, readFileSync(`${ROOT}${file}`, "utf8"));
  return contents.get(file)!;
};
const ids = functions.map((fn) => (fn as unknown as { opts: { id: string } }).opts.id);

describe("replay coverage (exit test 1)", () => {
  it("names a replay proof for every Inngest function, and for no function that is gone", () => {
    expect(Object.keys(PROOFS).sort(), "a function without a replay proof, or a proof for one that no longer exists").toEqual([...ids].sort());
  });

  it.each(Object.entries({ ...PROOFS, ...WEBHOOKS }))("%s: every named proof still exists", (_name, proofs) => {
    expect(proofs.length).toBeGreaterThan(0);
    for (const proof of proofs) expect(read(proof.file), `${proof.file} should have "${proof.test}"`).toContain(proof.test);
  });

  it("the sink the keys rely on still proves a repeated key sends nothing, even after an attempt that died (the claim)", () => {
    expect(read(SINK.file)).toContain(SINK.test);
    for (const proof of CLAIM) expect(read(proof.file), `${proof.file} should have "${proof.test}"`).toContain(proof.test);
  });

  it("lists every known gap, each pinned by a test that still exists (remove the entry when the gap is closed)", () => {
    for (const gap of KNOWN_GAPS) expect(read(gap.file), `${gap.file} should have "${gap.test}"`).toContain(gap.test);
  });
});

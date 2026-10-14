import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, GOOD_EXTRACTION, SYNTHETIC_SECRETS, timeout, type Injection, type SendScript, type World, type WorldOptions } from "../test-support/whole-turn-world";
import { captureLogs, describeLeaks, poison, type Fixtures, type LogCapture } from "./detect";

// Day 7, PR B: the log sweep over a whole turn. A customer message goes in through the REAL inbound webhook handler, becomes an event, and runs through the
// pipeline (the whole-turn harness, test-support/whole-turn-world.ts). Every console line written on the way is captured and searched for: the customer's
// number in any written form, anything token-shaped, every synthetic secret, and canary words planted in the customer's message, the knowledge base, the
// model's answers and the customer's name.
//
// POISON: every failure that is injected (a store error, a send error, a step that fails, a model that throws) carries a message packed with the number, the
// secrets and the canaries. Code that prints an error's message instead of its kind is caught.
//
// The lines the Inngest function itself writes (inngest/process-message.ts: `[pipeline] replied: ...`, `gave up after its retries ...`) are not run by the
// harness (it mirrors the function's steps, not its log statements): they are covered by the static guard (static-guard.test.ts), which checks what each
// of them interpolates.
//
// NOT PROVED here: the real notify.send (the world uses a labelled fake), the real database, Dev 2's code paths, the real model client's own logging beyond
// what its tests show, and staging logs. All values are synthetic.

const WA_ID = "919812345621";
const CANARY = { customer: "CANARY-CUSTOMER-7QX", reply: "CANARY-REPLY-9ZK", kb: "CANARY-KB-4WM", name: "Priya Canary", garbage: "CANARY-GARBAGE-2RT", question: "CANARY-QUESTION-3KD" };
const FX: Fixtures = { phones: [`+${WA_ID}`], secrets: SYNTHETIC_SECRETS, texts: Object.values(CANARY) };
const POISON = poison(FX);

const BASE: WorldOptions = {
  phone: WA_ID,
  profileName: CANARY.name,
  kbText: `2BHK of 950 sq ft in Velachery starts at ₹78 lakh. ${CANARY.kb}`,
  poison: POISON,
  model: {
    extraction: [JSON.stringify({ ...JSON.parse(GOOD_EXTRACTION), question: `price of a 2BHK? ${CANARY.question}` })],
    reply: [`A 2BHK starts at ₹78 lakh. ${CANARY.reply}`],
  },
};
const TEXT = { text: `What is the price of a 2BHK? ${CANARY.customer}` };

let capture: LogCapture | undefined;
afterEach(() => {
  capture?.stop();
  capture = undefined;
  vi.unstubAllEnvs();
});

type Play = (w: World) => Promise<void>;
const post: Play = async (w) => {
  await w.post("wamid.A1", TEXT);
  await w.drain();
};

/** Runs a scenario with every console line captured, and fails on any leak. */
async function sweep(options: WorldOptions, play: Play = post): Promise<LogCapture> {
  capture = captureLogs();
  const w = await createWorld({ ...BASE, ...options, model: { ...BASE.model, ...options.model } });
  await play(w);
  const cap = capture;
  expect(cap.lines().length, "the scenario wrote no log line at all: the sweep proves nothing").toBeGreaterThan(0);
  expect(cap.leaks(FX), `\n${describeLeaks(cap.leaks(FX))}`).toEqual([]);
  return cap;
}

describe("a clean turn", () => {
  it("logs what the pipeline's own steps log (the read receipt, the model, the store), nothing of the customer", async () => {
    const cap = await sweep({});
    expect(cap.lines().some((l) => l.startsWith("[pipeline] "))).toBe(true);
  });

  it("the same with the number, a longer message and the name as a customer really types them", async () => {
    await sweep({ phone: "919876543210", profileName: "Ramesh Kumar" }, async (w) => {
      await w.post("wamid.A1", { text: "Hi, I am Ramesh. Call me on +91 98765 43210 or 9876543210, email ramesh@example.test" });
      await w.drain();
    });
  });
});

describe("the model fails", () => {
  it("times out in the extraction", async () => void (await sweep({ model: { extraction: [timeout()] } })));
  it("times out in the reply", async () => void (await sweep({ model: { reply: [timeout()] } })));
  it("throws an unexpected error whose message carries the poison (extraction)", async () => void (await sweep({ model: { extraction: [new Error(POISON)] } })));
  it("throws an unexpected error whose message carries the poison (reply)", async () => void (await sweep({ model: { reply: [new Error(POISON)] } })));
  it("answers with garbage that quotes the customer, twice", async () => void (await sweep({ model: { extraction: [`not json ${CANARY.garbage} ${CANARY.customer}`, `{ "broken": ${CANARY.garbage}`] } })));
  it("answers with a reply the post-check refuses, twice (the refused text is not logged)", async () => void (await sweep({ model: { reply: [`It costs ₹99 lakh. ${CANARY.garbage}`, `It costs ₹99 lakh. ${CANARY.garbage}`] } })));
});

describe("the send fails", () => {
  const scripts: [string, SendScript[]][] = [
    ["retryable, once", ["retryable"]],
    ["retryable, on every attempt (the run gives up)", ["retryable", "retryable", "retryable", "retryable"]],
    ["retryable, on every attempt including the safe line", Array.from({ length: 5 }, () => "retryable" as const)],
    ["for good", ["permanent"]],
    ["with an unknown outcome that was delivered", ["unknown_delivered"]],
    ["with an unknown outcome that was lost", ["unknown_lost"]],
    ["reported as sent but never recorded", ["ok_unrecorded"]],
    ["by a crash after the provider accepted it", ["crash_after_accept"]],
  ];
  it.each(scripts)("%s", async (_name, sends) => void (await sweep({ sends })));
});

describe("a step fails (every step of the turn, before and after it runs), the failure carrying the poison", () => {
  it("every step", async () => {
    capture = captureLogs();
    const clean = await createWorld({ ...BASE });
    await clean.post("wamid.H1", TEXT);
    const steps = (await clean.drain())[0].steps;
    capture.stop();
    expect(steps.length).toBeGreaterThan(8);
    for (const stepId of steps) {
      for (const when of ["before", "after"] as const) {
        const inject: Injection[] = [{ stepId, when }];
        await sweep({}, async (w) => {
          await w.post("wamid.A1", TEXT);
          await w.drain({ inject });
        });
        capture?.stop();
        capture = undefined;
      }
    }
  });

  it("the run gives up (four failures of one step), so the failure handler runs", async () => {
    await sweep({}, async (w) => {
      await w.post("wamid.A1", TEXT);
      await w.drain({ inject: [{ stepId: "extract", when: "before", times: 4 }] });
    });
  });

  it.each(["getContact", "getConversation", "recentUnanswered", "getAgentMeta", "saveAgentMeta", "getBatchTexts", "getLead", "mergeLeadFields", "getTenantReplyInfo", "getHistory", "isAnswered"] as const)("the store throws in %s", async (op) => {
    await sweep({}, async (w) => {
      await w.post("wamid.A1", TEXT);
      w.fake.state.failNext.add(op);
      await w.drain();
    });
  });
});

describe("the other ways a turn ends", () => {
  it("a contact who opted out earlier", async () => void (await sweep({ optedOut: true })));
  it("a chat a person has", async () => void (await sweep({ mode: "human" })));
  it("the assistant switched off", async () => void (await sweep({ featureEnabled: false })));
  it("STOP", async () => void (await sweep({}, async (w) => (await w.post("wamid.S1", { text: "STOP" }), void (await w.drain())))));
  it("STOP in a chat a person has", async () => void (await sweep({ mode: "human" }, async (w) => (await w.post("wamid.S1", { text: "STOP" }), void (await w.drain())))));
  it("out of credits", async () => void (await sweep({ balance: 0 })));
  it("a voice note", async () => void (await sweep({}, async (w) => (await w.post("wamid.V1", { audio: true }), void (await w.drain())))));
  it("a burst of three messages", async () => {
    await sweep({}, async (w) => {
      await w.post("wamid.B1", { text: `Hi ${CANARY.customer}` }, 0);
      await w.post("wamid.B2", { text: "I want a 2BHK" }, 1);
      await w.post("wamid.B3", TEXT, 2);
      await w.drain({ debounce: true });
    });
  });
  it("two turns", async () => {
    await sweep({}, async (w) => {
      await w.post("wamid.A1", TEXT, 0);
      await w.drain();
      await w.post("wamid.A2", TEXT, 60);
      await w.drain();
    });
  });
});

describe("replays", () => {
  it("the same webhook and the same event twice, and Meta retrying after the turn", async () => {
    await sweep({ dedupeEvents: false }, async (w) => {
      await w.post("wamid.A1", TEXT);
      await w.post("wamid.A1", TEXT);
      await w.drain();
      await w.post("wamid.A1", TEXT);
      await w.drain();
    });
  });
});

describe("the failure handler (a run that gave up)", () => {
  it.each([
    ["an ordinary message", {}, TEXT],
    ["STOP", {}, { text: "STOP" }],
    ["a chat a person has", { mode: "human" as const }, TEXT],
    ["a contact who opted out", { optedOut: true }, TEXT],
  ])("%s", async (_name, options, content) => {
    await sweep(options, async (w) => {
      await w.post("wamid.A1", content);
      await w.drain({ inject: [{ stepId: "resolve", when: "before", times: 4 }] });
    });
  });

  it("a reply that went out and whose records were lost", async () => {
    await sweep({}, async (w) => {
      w.notify.afterRecorded = () => {
        w.failAudits(999);
        w.fake.state.failAlways.add("saveAgentMeta");
      };
      await w.post("wamid.A1", TEXT);
      await w.drain({ inject: [{ stepId: "reply", when: "after", times: 4 }] });
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld, GOOD_EXTRACTION, timeout, type Injection, type SendScript, type World, type WorldOptions } from "../../test-support/whole-turn-world";

// Day 7, PR A, the matrix: every injected failure against the invariant in whole-turn.test.ts (per TURN: at most one AI reply the customer receives,
// exactly one unless a test says why not; at most one reply row; credits spent minus refunded 1 when a reply was recorded, otherwise 0; every message
// answered). The world, the emulator and FakeNotify (a FAKE of notify.send) are in test-support/whole-turn-world.ts.

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const TEXT = { text: "What is the price of a 2BHK?" };
const SAFE = /Let me confirm that with the team/;

/** The steps a clean turn runs, read from one clean run, so a step added to the pipeline is injected without anyone remembering to add it here. */
async function stepsOfACleanTurn(): Promise<string[]> {
  const quiet = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  try {
    const w = await createWorld();
    await w.post("wamid.H1", TEXT);
    return (await w.drain())[0].steps;
  } finally {
    for (const spy of quiet) spy.mockRestore();
  }
}
const STEPS = await stepsOfACleanTurn();

async function oneMessage(options: WorldOptions = {}, run: { inject?: Injection[] } = {}): Promise<{ w: World; reports: Awaited<ReturnType<World["drain"]>> }> {
  const w = await createWorld(options);
  expect((await w.post("wamid.A1", TEXT)).status).toBe(200);
  return { w, reports: await w.drain(run) };
}

/** The turn ended with exactly one reply the customer received, recorded once and charged once, and every message answered. */
function expectOneReply(w: World, text?: RegExp): void {
  const r = w.report();
  expect(r.replies, "replies the customer received").toHaveLength(1);
  expect(r.replyRows, "reply rows recorded").toBe(1);
  expect(r.creditsNet, "credits spent and not refunded").toBe(1);
  expect(r.balance).toBeGreaterThanOrEqual(0);
  expect(r.answered, "every inbound message answered").toEqual(r.inbound);
  if (text) expect(r.replies[0].text).toMatch(text);
}

/** The customer received nothing from the assistant, and nothing was charged. */
function expectNoReply(w: World): void {
  const r = w.report();
  expect(r.replies).toHaveLength(0);
  expect(r.replyRows).toBe(0);
  expect(r.creditsNet).toBe(0);
  expect(r.balance).toBeGreaterThanOrEqual(0);
}

it("reads the steps of the turn from a clean run", () => {
  expect(STEPS).toEqual(expect.arrayContaining(["started", "resolve", "batch", "lead", "gate", "stop-check", "extract", "plan", "reply"]));
});

describe("the model times out", () => {
  it("in the extraction: the customer gets the safe line, once, and the extraction is not paid for again by a step retry", async () => {
    const { w, reports } = await oneMessage({ model: { extraction: [timeout()] } });
    expect(reports[0].status).toBe("completed");
    expectOneReply(w, SAFE);
    expect(w.model.calls.extraction).toBe(1);
    expect(w.model.calls.reply).toBe(0);
  });

  it("in the reply: the customer gets the safe line, once", async () => {
    const { w } = await oneMessage({ model: { reply: [timeout()] } });
    expectOneReply(w, SAFE);
  });

  it("in both: the customer gets the safe line, once", async () => {
    const { w } = await oneMessage({ model: { extraction: [timeout()], reply: [timeout()] } });
    expectOneReply(w, SAFE);
  });

  it("and the webhook and the event are replayed: still one", async () => {
    const w = await createWorld({ model: { extraction: [timeout()] }, dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    await w.post("wamid.A1", TEXT);
    await w.drain();
    expectOneReply(w, SAFE);
  });
});

describe("the model's JSON is bad twice", () => {
  it("garbage, then garbage: one clarifying question, and the reply model is never asked", async () => {
    const { w } = await oneMessage({ model: { extraction: ["I am sorry, I cannot do that", "{broken"] } });
    expectOneReply(w, /couldn't quite understand/);
    expect(w.model.calls).toEqual({ extraction: 2, reply: 0 });
  });

  it("valid JSON that is not an extraction, twice: the same", async () => {
    const wrong = JSON.stringify({ intent: "definitely_not_an_intent", confidence: 7 });
    const { w } = await oneMessage({ model: { extraction: [wrong, wrong] } });
    expectOneReply(w, /couldn't quite understand/);
    expect(w.model.calls.extraction).toBe(2);
  });

  it("garbage, then a good answer: the good one is used, once", async () => {
    const { w } = await oneMessage({ model: { extraction: ["nope", GOOD_EXTRACTION] } });
    expectOneReply(w, /₹78 lakh/);
    expect(w.model.calls.extraction).toBe(2);
  });

  it("the reply fails the post-check twice (a price that is not in the facts): the safe line, once", async () => {
    const { w } = await oneMessage({ model: { reply: ["It costs ₹99 lakh.", "It costs ₹99 lakh."] } });
    expectOneReply(w, SAFE);
    expect(w.model.calls.reply).toBe(2);
  });

  it("an extraction with a field key the pack does not have: the key is dropped, the customer still gets one reply", async () => {
    const odd = JSON.stringify({ language: "en", intent: "question", fields: { wallet_balance: "9999", location: "Velachery" }, question: "price?", preferredTime: null, sentiment: "neutral", asksIfHuman: false, confidence: 0.9 });
    const { w } = await oneMessage({ model: { extraction: [odd] } });
    expectOneReply(w);
    expect([...w.fake.leads.values()][0].fields).not.toHaveProperty("wallet_balance");
  });
});

describe("a send that fails in a way waiting can fix (retryable)", () => {
  it.each([1, 2, 3])("%i time(s) and then works: the step is retried, one delivery, one credit", async (failures) => {
    const sends: SendScript[] = Array.from({ length: failures }, () => "retryable");
    const { w, reports } = await oneMessage({ sends });
    expect(reports[0]).toMatchObject({ status: "completed" });
    expect(reports[0].attempts.reply).toBe(failures + 1);
    expectOneReply(w, /₹78 lakh/);
    expect(w.report().sendCalls).toBe(failures + 1);
  });

  it("on all four attempts: the run gives up and the failure handler sends the safe line, once", async () => {
    const { w, reports } = await oneMessage({ sends: ["retryable", "retryable", "retryable", "retryable"] });
    expect(reports[0]).toMatchObject({ status: "failed", giveUp: "sent" });
    expectOneReply(w, SAFE);
    expect(w.report().sendCalls).toBe(5);
  });

  it("PINNED, existing behaviour: when even the safe line cannot be sent the customer hears nothing and nothing is charged, and the message stays unanswered for the next run", async () => {
    const { w, reports } = await oneMessage({ sends: Array.from({ length: 5 }, () => "retryable" as const) });
    expect(reports[0]).toMatchObject({ status: "failed", giveUp: "not_sent" });
    expectNoReply(w);
    expect(w.report().answered).toEqual([]);
    // the next message of the customer collects it (the step 8 audit's "never silence" note)
    await w.post("wamid.A2", { text: "hello?" }, 5);
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(1);
    expect(r.answered).toEqual(r.inbound);
  });

  it("PINNED, existing behaviour: a send that failed for good is not retried: nothing is delivered or charged, no second attempt, no handover, and the message stays unanswered until the customer writes again", async () => {
    const { w, reports } = await oneMessage({ sends: ["permanent"] });
    expect(reports[0]).toMatchObject({ status: "completed" });
    expect(reports[0].attempts.reply).toBe(1);
    expectNoReply(w);
    expect(w.report().sendCalls).toBe(1);
    expect(w.report().answered).toEqual([]);
    expect(w.report().handoffs).toBe(0);
  });
});

describe("a send whose outcome is unknown (no answer in time)", () => {
  it("and the provider delivered it: never sent again, even when the event and the webhook are replayed; the credit was refunded (contracts decision 16)", async () => {
    const w = await createWorld({ sends: ["unknown_delivered"], dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    await w.drain();
    await w.post("wamid.A1", TEXT);
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(1);
    expect(r.sendCalls).toBe(1);
    expect(r.replyRows).toBe(0); // notify_record never ran
    expect(r.creditsNet).toBe(0);
    expect(r.answered).toEqual(r.inbound);
  });

  it("and the provider did not deliver it: still never sent again (PINNED by design: the customer hears nothing, and the message counts as answered)", async () => {
    const { w } = await oneMessage({ sends: ["unknown_lost"] });
    const r = w.report();
    expect(r.replies).toHaveLength(0);
    expect(r.sendCalls).toBe(1);
    expect(r.creditsNet).toBe(0);
    expect(r.answered).toEqual(r.inbound);
  });
});

describe("a step fails once, at every step of the turn", () => {
  it.each(STEPS.flatMap((id) => (["before", "after"] as const).map((when) => [id, when] as const)))("%s fails %s it runs: the step is retried and the customer gets one reply", async (stepId, when) => {
    const { w, reports } = await oneMessage({}, { inject: [{ stepId, when }] });
    expect(reports[0].status).toBe("completed");
    expect(reports[0].attempts[stepId]).toBe(2);
    expectOneReply(w, /₹78 lakh/);
    // a replay uses what the step saved: the model is not paid for the same answer twice
    if (stepId === "extract" && when === "after") expect(w.model.calls.extraction).toBe(1);
  });

  it("the marker write fails right after the reply was sent: that is absorbed (no retry, no second send), the rows are still written", async () => {
    const w = await createWorld();
    w.notify.afterRecorded = () => w.fake.state.failNext.add("saveAgentMeta");
    await w.post("wamid.A1", TEXT);
    const [report] = await w.drain();
    expect(report.status).toBe("completed");
    expect(report.attempts.reply).toBe(1);
    expect(w.report().sendCalls).toBe(1);
    expectOneReply(w, /₹78 lakh/);
  });

  it("the audit rows fail right after the reply was sent: the turn still ends well (one delivery); the event replayed later finds the marker, writes the rows and sends nothing", async () => {
    const w = await createWorld();
    w.notify.afterRecorded = () => w.failAudits(99);
    await w.post("wamid.A1", TEXT);
    const [first] = await w.drain();
    expect(first.status).toBe("completed");
    expect(w.report().replies).toHaveLength(1);
    expect(w.report().answered).toEqual([]); // the rows could not be written
    w.failAudits(0);
    const again = await w.runFunction({ data: w.events[0].data });
    expect(again.status).toBe("completed");
    expectOneReply(w, /₹78 lakh/); // the rows are there now, and still one delivery
    expect(w.report().sendCalls).toBe(1);
  });

  it("the process dies between a recorded send and the step's own records (no marker, no rows yet): the retry sends under the same key and is answered with the first send, one delivery", async () => {
    const w = await createWorld();
    let died = false;
    w.notify.afterRecorded = () => {
      if (died) return;
      died = true;
      throw new Error("the process died after the send was recorded (simulated)");
    };
    await w.post("wamid.A1", TEXT);
    const [report] = await w.drain();
    expect(report.status).toBe("completed");
    expect(report.attempts.reply).toBe(2);
    expect(w.report().sendCalls).toBe(2);
    expectOneReply(w, /₹78 lakh/);
  });

  it("the step fails after its send on its first two attempts: still one delivery", async () => {
    const { w, reports } = await oneMessage({}, { inject: [{ stepId: "reply", when: "after", times: 2 }] });
    expect(reports[0].status).toBe("completed");
    expect(reports[0].attempts.reply).toBe(3);
    expectOneReply(w, /₹78 lakh/);
  });

  it("the extraction step failing on all four attempts gives up, and the failure handler sends the safe line", async () => {
    const { w, reports } = await oneMessage({}, { inject: [{ stepId: "extract", when: "before", times: 4 }] });
    expect(reports[0]).toMatchObject({ status: "failed", giveUp: "sent" });
    expectOneReply(w, SAFE);
  });

  it("the reply step failing AFTER its send on every attempt: the reply went out under one key, so the failure handler adds nothing", async () => {
    const { w, reports } = await oneMessage({}, { inject: [{ stepId: "reply", when: "after", times: 4 }] });
    expect(reports[0]).toMatchObject({ status: "failed", giveUp: "nothing_to_do" });
    expectOneReply(w, /₹78 lakh/);
  });
});

describe("the same event twice", () => {
  it("a second run of the function for the same event finds the message answered and does nothing", async () => {
    const { w, reports } = await oneMessage();
    const again = await w.runFunction({ data: w.events[0].data });
    expect(again.returned).toMatchObject({ status: "skipped", reason: "already_answered" });
    expect(w.model.calls).toEqual({ extraction: 1, reply: 1 });
    expectOneReply(w);
    expect(reports[0].status).toBe("completed");
  });

  it("delivered twice by the queue (no dedupe): two runs, one reply", async () => {
    const w = await createWorld({ dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    w.events.push({ ...w.events[0], ran: false });
    const reports = await w.drain();
    expect(reports).toHaveLength(2);
    expectOneReply(w);
  });
});

describe("the same webhook twice", () => {
  it("Inngest drops the second event: one message stored, one run, one reply", async () => {
    const w = await createWorld();
    await w.post("wamid.A1", TEXT);
    await w.post("wamid.A1", TEXT);
    expect(w.events.map((e) => e.dropped)).toEqual([false, true]);
    expect(await w.drain()).toHaveLength(1);
    expect(w.report().inbound).toHaveLength(1);
    expectOneReply(w);
  });

  it("Inngest delivers both anyway: two runs, the second finds it answered, one reply", async () => {
    const w = await createWorld({ dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    await w.post("wamid.A1", TEXT);
    expect(await w.drain()).toHaveLength(2);
    expect(w.report().inbound).toHaveLength(1);
    expectOneReply(w);
  });

  it("Meta retries long after the turn finished: nothing more is sent", async () => {
    const w = await createWorld({ dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    await w.drain();
    await w.post("wamid.A1", TEXT);
    await w.drain();
    expectOneReply(w);
    expect(w.model.calls).toEqual({ extraction: 1, reply: 1 });
  });
});

describe("failures together", () => {
  it("a replayed webhook, a replayed event and two retryable send failures: one reply", async () => {
    const w = await createWorld({ sends: ["retryable", "retryable"], dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    await w.post("wamid.A1", TEXT);
    await w.drain();
    await w.post("wamid.A1", TEXT);
    await w.drain();
    expectOneReply(w);
  });

  it("an unknown outcome, then the event and the webhook replayed: the send is made once", async () => {
    const w = await createWorld({ sends: ["unknown_delivered"], dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    await w.post("wamid.A1", TEXT);
    await w.drain();
    const r = w.report();
    expect(r.sendCalls).toBe(1);
    expect(r.replies).toHaveLength(1);
  });

  it("the extraction times out, the send fails once, and the reply step fails after sending: one safe line", async () => {
    const w = await createWorld({ model: { extraction: [timeout()] }, sends: ["retryable"] });
    await w.post("wamid.A1", TEXT);
    await w.drain({ inject: [{ stepId: "reply", when: "after" }] });
    expectOneReply(w, SAFE);
  });

  it("a step retry after the lead is made and a replayed webhook: one lead, one reply", async () => {
    const w = await createWorld({ dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    await w.post("wamid.A1", TEXT);
    await w.drain({ inject: [{ stepId: "lead", when: "after" }] });
    expect(w.fake.leads.size).toBe(1);
    expectOneReply(w);
  });
});

describe("the shape of the traffic", () => {
  it("a burst of three messages is answered together by ONE reply, and all three are answered", async () => {
    const w = await createWorld();
    await w.post("wamid.B1", { text: "Hi" }, 0);
    await w.post("wamid.B2", { text: "I want a 2BHK" }, 1);
    await w.post("wamid.B3", { text: "What is the price of a 2BHK?" }, 2);
    expect(await w.drain({ debounce: true })).toHaveLength(1);
    expect(w.report().inbound).toHaveLength(3);
    expectOneReply(w);
  });

  it("the same burst stored before the first run, with three runs (no debounce): the first answers all three, the others find them answered: still one reply", async () => {
    const w = await createWorld();
    await w.post("wamid.B1", { text: "Hi" }, 0);
    await w.post("wamid.B2", { text: "I want a 2BHK" }, 1);
    await w.post("wamid.B3", { text: "What is the price of a 2BHK?" }, 2);
    await w.drain();
    expectOneReply(w);
  });

  it("a message that arrives after the first run finished, inside the batch window, is its own turn: two replies, one each, and the first message is not answered twice", async () => {
    const w = await createWorld();
    await w.post("wamid.B1", { text: "Hi" }, 0);
    await w.drain();
    await w.post("wamid.B2", TEXT, 5);
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(2);
    expect(r.replyRows).toBe(2);
    expect(new Set(r.replies.map((d) => d.key)).size).toBe(2);
    expect(r.answered).toEqual(r.inbound);
  });

  it("two separate turns get one reply each, under different keys", async () => {
    const w = await createWorld();
    await w.post("wamid.A1", TEXT, 0);
    await w.drain();
    await w.post("wamid.A2", { text: "And a 3BHK?" }, 60);
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(2);
    expect(r.replyRows).toBe(2);
    expect(r.creditsNet).toBe(2);
    expect(new Set(r.replies.map((d) => d.key)).size).toBe(2);
    expect(r.answered).toEqual(r.inbound);
  });
});

describe("the other ways a turn ends", () => {
  it("a contact who opted out earlier: nothing is sent, even when the event and the webhook are replayed", async () => {
    const w = await createWorld({ optedOut: true, dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    await w.post("wamid.A1", TEXT);
    await w.drain();
    expectNoReply(w);
    expect(w.report().notices).toHaveLength(0);
    expect(w.model.calls).toEqual({ extraction: 0, reply: 0 });
  });

  it("a chat a person has taken over: nothing is sent, the model is never asked", async () => {
    const w = await createWorld({ mode: "human", dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    await w.post("wamid.A1", TEXT);
    await w.drain();
    expectNoReply(w);
    expect(w.report().notices).toHaveLength(0);
    expect(w.model.calls).toEqual({ extraction: 0, reply: 0 });
  });

  it("STOP: the contact is opted out and gets ONE confirmation, no reply, however often the event and the webhook come", async () => {
    const w = await createWorld({ dedupeEvents: false });
    await w.post("wamid.S1", { text: "STOP" });
    await w.post("wamid.S1", { text: "STOP" });
    await w.drain();
    await w.post("wamid.S1", { text: "STOP" });
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(0);
    expect(r.notices).toHaveLength(1);
    expect(w.fake.contacts.get("b0000000-0000-4000-8000-0000000000b1")?.optedOut).toBe(true);
    expect(w.model.calls).toEqual({ extraction: 0, reply: 0 });
  });

  it("STOP, then a new message: nothing is sent to the opted-out contact", async () => {
    const w = await createWorld();
    await w.post("wamid.S1", { text: "STOP" });
    await w.drain();
    await w.post("wamid.S2", TEXT, 60);
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(0);
    expect(r.notices).toHaveLength(1);
    expect(w.model.calls).toEqual({ extraction: 0, reply: 0 });
  });

  it("out of credits: no AI reply, ONE holding line, one handover, the balance never negative, and a replay adds nothing", async () => {
    const w = await createWorld({ balance: 0, dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    await w.post("wamid.A1", TEXT);
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(0);
    expect(r.notices).toHaveLength(1);
    expect(r.handoffs).toBe(1);
    expect(r.balance).toBe(0);
    expect(r.creditsNet).toBe(0);
  });

  it("a voice note: one line asking the customer to type, once, and staff are told once, however often it is replayed", async () => {
    const w = await createWorld({ dedupeEvents: false });
    await w.post("wamid.V1", { audio: true });
    await w.post("wamid.V1", { audio: true });
    await w.drain();
    expectOneReply(w, /voice note/i);
    expect(w.model.calls).toEqual({ extraction: 0, reply: 0 });
    expect(w.handoffEvents.filter((e) => e.name === "voice_note.received")).toHaveLength(1);
  });

  it("a second voice note right after is not answered again", async () => {
    const w = await createWorld();
    await w.post("wamid.V1", { audio: true }, 0);
    await w.drain();
    await w.post("wamid.V2", { audio: true }, 60);
    await w.drain();
    expect(w.report().replies).toHaveLength(1);
  });
});

describe("KNOWN GAP (Day 6 note on the reply idempotency key, section 3.1; it is inside Dev 2's notify.send)", () => {
  it("a crash after WhatsApp accepted the reply and before notify.send records it sends the reply TWICE: the key was never recorded, so the retry sends again. Passes while the gap exists; when notify.send closes it, change 2 to 1", async () => {
    const { w, reports } = await oneMessage({ sends: ["crash_after_accept"] });
    expect(reports[0]).toMatchObject({ status: "completed" });
    expect(reports[0].attempts.reply).toBe(2);
    const r = w.report();
    expect(r.replies).toHaveLength(2); // THE GAP: two deliveries for one turn
    expect(r.replyRows).toBe(1);
    expect(r.creditsNet).toBe(2); // and the first attempt's credit was never refunded
    expect(r.answered).toEqual(r.inbound);
  });
});

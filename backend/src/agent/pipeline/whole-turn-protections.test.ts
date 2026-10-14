import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTACT, CONV, createWorld, GOOD_REPLY, timeout, type Injection, type World, type WorldOptions } from "../../test-support/whole-turn-world";

// Day 7, PR A, part 3: the protections the first matrix did not reach (found by the independent review): the failure handler's own checks, STOP in a
// chat a person has and with the assistant switched off, the re-reads right before the send, the handover and the holding line under a replay, and a
// step failure at every step of the OTHER paths (STOP, voice note, out of credits, a chat a person has), not only the clean one.
// What FakeNotify is, and what these tests do and do not prove about notify.send, is in test-support/whole-turn-world.ts.

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const TEXT = { text: "What is the price of a 2BHK?" };
const STOP = { text: "STOP" };
const SAFE = /Let me confirm that with the team/;

async function run(options: WorldOptions, content: { text: string } | { audio: true }, inject: Injection[] = []): Promise<{ w: World; reports: Awaited<ReturnType<World["drain"]>> }> {
  const w = await createWorld(options);
  await w.post("wamid.A1", content);
  return { w, reports: await w.drain({ inject }) };
}

const optedOut = (w: World) => w.fake.contacts.get(CONTACT)?.optedOut === true;

describe("the failure handler (a run that gave up) keeps every check the run itself has", () => {
  it("a STOP turn whose run fails: the handler applies the STOP, sends the one confirmation, and no safe line", async () => {
    const { w, reports } = await run({}, STOP, [{ stepId: "stop-check", when: "before", times: 4 }]);
    expect(reports[0]).toMatchObject({ status: "failed", giveUp: "opted_out" });
    const r = w.report();
    expect(r.replies).toHaveLength(0);
    expect(r.notices).toHaveLength(1);
    expect(optedOut(w)).toBe(true);
  });

  it("a chat a person has, whose run fails: the handler sends nothing, not even tries to", async () => {
    const { w, reports } = await run({ mode: "human" }, TEXT, [{ stepId: "resolve", when: "before", times: 4 }]);
    expect(reports[0]).toMatchObject({ status: "failed", giveUp: "nothing_to_do" });
    expect(w.notify.calls).toHaveLength(0);
  });

  it("a contact who opted out, whose run fails: the handler sends nothing, not even tries to (the fake would refuse it, so the attempt is what is counted)", async () => {
    const { w, reports } = await run({ optedOut: true }, TEXT, [{ stepId: "resolve", when: "before", times: 4 }]);
    expect(reports[0]).toMatchObject({ status: "failed", giveUp: "nothing_to_do" });
    expect(w.notify.calls).toHaveLength(0);
  });

  it("a contact who asks to stop WHILE the run fails before its STOP check: still opted out, never the safe line", async () => {
    const { w, reports } = await run({}, STOP, [{ stepId: "lead", when: "before", times: 4 }]);
    expect(reports[0]).toMatchObject({ status: "failed", giveUp: "opted_out" });
    expect(w.report().replies).toHaveLength(0);
  });
});

describe("STOP in a chat a person has, and with the assistant switched off", () => {
  it("STOP in a chat a person has: the contact is opted out and gets the one confirmation, however often it is replayed", async () => {
    const w = await createWorld({ mode: "human", dedupeEvents: false });
    await w.post("wamid.S1", STOP);
    await w.post("wamid.S1", STOP);
    await w.drain();
    expect(optedOut(w)).toBe(true);
    expect(w.report().notices).toHaveLength(1);
    expect(w.report().replies).toHaveLength(0);
  });

  it("STOP with the assistant switched off: the same (an opt-out never depends on a toggle)", async () => {
    const w = await createWorld({ featureEnabled: false, dedupeEvents: false });
    await w.post("wamid.S1", STOP);
    await w.post("wamid.S1", STOP);
    await w.drain();
    expect(optedOut(w)).toBe(true);
    expect(w.report().notices).toHaveLength(1);
  });

  it("an ordinary message with the assistant switched off: nothing is sent and the model is never asked", async () => {
    const w = await createWorld({ featureEnabled: false });
    await w.post("wamid.A1", TEXT);
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(0);
    expect(r.notices).toHaveLength(0);
    expect(w.model.calls).toEqual({ extraction: 0, reply: 0 });
  });
});

describe("the checks right before the send, while the reply model is thinking", () => {
  it("the customer sends STOP meanwhile: no reply is sent (the fake is never even asked)", async () => {
    const w = await createWorld({ model: { reply: [() => (w.fake.contacts.get(CONTACT)!.optedOut = true, GOOD_REPLY)] } });
    await w.post("wamid.A1", TEXT);
    await w.drain();
    expect(w.report().replies).toHaveLength(0);
    expect(w.notify.calls.filter((c) => c.kind === "ai_reply")).toHaveLength(0);
  });

  it("a team member takes the chat over meanwhile: no reply is sent (the fake is never even asked)", async () => {
    const w = await createWorld({ model: { reply: [() => (w.fake.conversations.get(CONV)!.mode = "human", GOOD_REPLY)] } });
    await w.post("wamid.A1", TEXT);
    await w.drain();
    expect(w.report().replies).toHaveLength(0);
    expect(w.notify.calls.filter((c) => c.kind === "ai_reply")).toHaveLength(0);
  });

  it("another run answers the message meanwhile: this run sends nothing", async () => {
    const w = await createWorld({ model: { reply: [() => (w.fake.answered.set(w.report().inbound[0], Date.now()), GOOD_REPLY)] } });
    await w.post("wamid.A1", TEXT);
    await w.drain();
    expect(w.report().replies).toHaveLength(0);
    expect(w.notify.calls.filter((c) => c.kind === "ai_reply")).toHaveLength(0);
  });
});

describe("out of credits, under a replay of the step that sends", () => {
  it("the reply step fails after the holding line and the handover: still one holding line and one handover", async () => {
    const w = await createWorld({ balance: 0 });
    await w.post("wamid.A1", TEXT);
    const [report] = await w.drain({ inject: [{ stepId: "reply", when: "after", times: 2 }, { stepId: "handoff", when: "after", times: 2 }] });
    expect(report.status).toBe("completed");
    const r = w.report();
    expect(r.replies).toHaveLength(0);
    expect(r.notices).toHaveLength(1);
    expect(r.handoffs).toBe(1);
    expect(r.balance).toBe(0);
  });
});

describe("a send reported as sent but never recorded (notify_record failed: the key is not known to a later send)", () => {
  it("the step then fails and is retried: the marker the first attempt left stops a second send", async () => {
    const { w, reports } = await run({ sends: ["ok_unrecorded"] }, TEXT, [{ stepId: "reply", when: "after" }]);
    expect(reports[0].status).toBe("completed");
    expect(w.report().replies).toHaveLength(1);
    expect(w.report().sendCalls).toBe(1);
  });

  it("the event and the webhook are replayed later: nothing more is sent", async () => {
    const w = await createWorld({ sends: ["ok_unrecorded"], dedupeEvents: false });
    await w.post("wamid.A1", TEXT);
    await w.drain();
    await w.post("wamid.A1", TEXT);
    await w.drain();
    expect(w.report().replies).toHaveLength(1);
    expect(w.report().sendCalls).toBe(1);
  });
});

describe("KNOWN LIMIT (Day 6 note on the reply idempotency key, section 3.2): the reply went out, its records were lost, and the run then gives up", () => {
  it("the failure handler cannot tell the reply went out, so it sends the safe line as well: TWO messages. Passes while the limit exists; if it fails with one message, the limit was closed", async () => {
    const w = await createWorld();
    // The reply is sent and recorded by notify.send; then the audit is down (no answered rows) and the marker write is lost, and the step fails on every attempt.
    w.notify.afterRecorded = () => {
      w.failAudits(999);
      w.fake.state.failNext.add("saveAgentMeta");
    };
    await w.post("wamid.A1", TEXT);
    const [report] = await w.drain({ inject: [{ stepId: "reply", when: "after", times: 4 }] });
    expect(report.status).toBe("failed");
    const r = w.report();
    expect(r.replies.filter((d) => d.key?.startsWith("reply:"))).toHaveLength(1);
    // What is observed today:
    expect(report.giveUp).toBe("sent");
    expect(r.replies).toHaveLength(2); // THE LIMIT: the reply, then the safe line under gave_up:<message>
    expect(r.replies.map((d) => d.key?.split(":")[0]).sort()).toEqual(["gave_up", "reply"]);
  });
});

/** A step failing once, before and after it runs, at every step the path runs. The invariant of the path must hold each time. */
function everyStepOf(name: string, options: WorldOptions, content: { text: string } | { audio: true }, expectPath: (w: World) => void): void {
  describe(`${name}: a step fails once, at every step of this path`, () => {
    it("reads the steps of the path", async () => {
      const { reports } = await run(options, content);
      expect(reports[0].steps.length).toBeGreaterThan(4);
      expect(reports[0].steps[0]).toBe("started");
    });

    const steps = (async () => (await run(options, content)).reports[0].steps)();
    for (const when of ["before", "after"] as const) {
      it(`fails ${when} running: every step is retried once and the path ends the same`, async () => {
        for (const stepId of await steps) {
          const { w, reports } = await run(options, content, [{ stepId, when }]);
          expect(reports[0].status, `${stepId} ${when}`).toBe("completed");
          expect(reports[0].attempts[stepId], `${stepId} ${when}`).toBe(2);
          expectPath(w);
        }
      });
    }
  });
}

everyStepOf("STOP", {}, STOP, (w) => {
  const r = w.report();
  expect(r.replies).toHaveLength(0);
  expect(r.notices).toHaveLength(1);
  expect(optedOut(w)).toBe(true);
});

everyStepOf("STOP in a chat a person has", { mode: "human" }, STOP, (w) => {
  const r = w.report();
  expect(r.replies).toHaveLength(0);
  expect(r.notices).toHaveLength(1);
  expect(optedOut(w)).toBe(true);
});

everyStepOf("a voice note", {}, { audio: true }, (w) => {
  const r = w.report();
  expect(r.replies).toHaveLength(1);
  expect(r.replies[0].text).toMatch(/voice note/i);
  expect(r.replyRows).toBe(1);
  expect(r.creditsNet).toBe(1);
  // a step retried after it sent the event sends it again under the SAME id, which Inngest drops
  expect(new Set(w.handoffEvents.filter((e) => e.name === "voice_note.received").map((e) => e.id)).size).toBe(1);
});

everyStepOf("out of credits", { balance: 0 }, TEXT, (w) => {
  const r = w.report();
  expect(r.replies).toHaveLength(0);
  expect(r.notices).toHaveLength(1);
  expect(r.handoffs).toBe(1);
  expect(r.balance).toBe(0);
});

everyStepOf("a chat a person has", { mode: "human" }, TEXT, (w) => {
  const r = w.report();
  expect(r.replies).toHaveLength(0);
  expect(r.notices).toHaveLength(0);
});

everyStepOf("a model that times out", { model: { extraction: [timeout()] } }, TEXT, (w) => {
  const r = w.report();
  expect(r.replies).toHaveLength(1);
  expect(r.replies[0].text).toMatch(SAFE);
  expect(r.replyRows).toBe(1);
  expect(r.creditsNet).toBe(1);
});

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

describe("a reply went out, its records were lost, and the run then gives up (was KNOWN LIMIT 2, Day 6 note section 3.2: closed by this PR)", () => {
  it("the audit is down and the marker write fails once, and the step fails on every attempt: the failure handler finds the marker the retry left and sends NO safe line: one message", async () => {
    const w = await createWorld();
    w.notify.afterRecorded = () => {
      w.failAudits(999);
      w.fake.state.failNext.add("saveAgentMeta");
    };
    await w.post("wamid.A1", TEXT);
    const [report] = await w.drain({ inject: [{ stepId: "reply", when: "after", times: 4 }] });
    expect(report.status).toBe("failed");
    expect(report.giveUp).toBe("already_replied");
    const r = w.report();
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0].key?.startsWith("reply:")).toBe(true);
    expect(r.replies.some((d) => d.key?.startsWith("gave_up:"))).toBe(false);
  });

  it("the marker is lost TOO (every marker write fails) and the audit is down: the recorded reply row proves it, so still NO safe line", async () => {
    const w = await createWorld();
    w.notify.afterRecorded = () => {
      w.failAudits(999);
      w.fake.state.failAlways.add("saveAgentMeta");
    };
    await w.post("wamid.A1", TEXT);
    const [report] = await w.drain({ inject: [{ stepId: "reply", when: "after", times: 4 }] });
    expect(report.status).toBe("failed");
    expect(report.giveUp).toBe("already_replied");
    const r = w.report();
    expect(r.replies).toHaveLength(1);
    expect(r.replyRows).toBe(1);
    expect(r.replies.some((d) => d.key?.startsWith("gave_up:"))).toBe(false);
  });

  it("the same when the records cannot even be read by the handler: it fails open and sends the safe line (never silence), once, under its own key", async () => {
    const w = await createWorld();
    w.notify.afterRecorded = () => {
      w.failAudits(999);
      w.fake.state.failAlways.add("saveAgentMeta");
    };
    await w.post("wamid.A1", TEXT);
    // the recorded rows cannot be read: the check cannot be made (the marker is lost too)
    w.fake.state.failAlways.add("recordedMessageIds");
    const [report] = await w.drain({ inject: [{ stepId: "reply", when: "after", times: 4 }] });
    expect(report.giveUp).toBe("sent");
    expect(w.report().replies.filter((d) => d.key?.startsWith("gave_up:"))).toHaveLength(1);
  });
});

describe("KNOWN LIMIT 2b (what remains after this PR; the root cause is KNOWN GAP 1, inside Dev 2's notify.send): the reply was delivered but NOTHING of ours recorded it", () => {
  it("notify_record failed (the send is reported as sent, no row), the marker and the audit rows are lost, and the step fails on every attempt: no signal exists, so the retries resend (the notify gap) and the handler adds one safe line. Passes while this exists; it needs a pending record from notify.send to close", async () => {
    const w = await createWorld({ sends: ["ok_unrecorded", "ok_unrecorded", "ok_unrecorded", "ok_unrecorded"] });
    w.notify.afterDelivered = () => {
      w.failAudits(999);
      w.fake.state.failAlways.add("saveAgentMeta");
    };
    await w.post("wamid.A1", TEXT);
    const [report] = await w.drain({ inject: [{ stepId: "reply", when: "after", times: 4 }] });
    expect(report.status).toBe("failed");
    expect(report.giveUp).toBe("sent");
    const r = w.report();
    expect(w.notify.rows.filter((d) => d.key?.startsWith("reply:"))).toHaveLength(0); // none of the replies was recorded anywhere (only the safe line was)
    expect(r.replies.filter((d) => d.key?.startsWith("reply:"))).toHaveLength(4); // the notify gap: an unrecorded key cannot dedupe
    expect(r.replies.filter((d) => d.key?.startsWith("gave_up:"))).toHaveLength(1); // and the safe line on top
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

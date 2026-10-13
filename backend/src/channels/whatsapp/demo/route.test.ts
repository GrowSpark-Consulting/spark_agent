import { describe, expect, it, vi } from "vitest";
import { DEMO_DAILY_LIMIT, routeDemoMessage, type DemoDeps } from "./route";
import type { MenuEntry } from "./text";

const A = "a0000000-0000-4000-8000-00000000000a"; // a demo business
const B = "b0000000-0000-4000-8000-00000000000b"; // a business on trial
const C = "c0000000-0000-4000-8000-00000000000c"; // another demo business
const PHONE = "+919800000001";
const DESK = "d0000000-0000-4000-8000-0000000000d0"; // the business that owns the number's connection
const CHANNEL = "ca000000-0000-4000-8000-0000000000c1";
const MENU: MenuEntry[] = [
  { code: "DEMO-INTERIORS", label: "Interior design" },
  { code: "DEMO-SALON", label: "Beauty parlour" },
];

type Admit = { allowed: boolean; replay: boolean; notifyLimit: boolean; tenantId: string | null };
type Claim = "claimed" | "other_sender" | "taken";

/**
 * The fake database behaves like demo_admit for what the rules need: a valid code's business is the message's business and becomes the visitor's
 * route; otherwise the route is; a replay answers with the business it was first admitted for.
 */
function fakes(
  over: {
    session?: string | null;
    routes?: Record<string, { tenantId: string; kind: "demo" | "trial" }>;
    allowed?: boolean;
    notifyLimit?: boolean;
    replayOf?: string | null;
    dead?: string[];
    claim?: Claim;
    /** The business whose chat already holds this message (a redelivery); null: none. */
    holder?: string | null;
  } = {},
) {
  const routes = over.routes ?? { "DEMO-SALON": { tenantId: A, kind: "demo" }, "DEMO-INTERIORS": { tenantId: C, kind: "demo" }, "TRIAL-7F3K": { tenantId: B, kind: "trial" } };
  let session = over.session ?? null;
  const deps = {
    findRoute: vi.fn(async (code: string) => routes[code] ?? null),
    isLive: vi.fn(async (tenantId: string) => !(over.dead ?? []).includes(tenantId)),
    claimTrialPhone: vi.fn<DemoDeps["claimTrialPhone"]>(async () => over.claim ?? "claimed"),
    hasRoute: vi.fn(async () => session !== null),
    menu: vi.fn(async () => MENU),
    messageTenant: vi.fn<(args: { providerMsgId: string; channelId: string }) => Promise<string | null>>(async () => over.holder ?? null),
    admit: vi.fn<DemoDeps["admit"]>(async ({ routeTenantId }): Promise<Admit> => {
      if (over.allowed === false) return { allowed: false, replay: false, notifyLimit: over.notifyLimit ?? false, tenantId: null };
      if (over.replayOf !== undefined) return { allowed: true, replay: true, notifyLimit: false, tenantId: over.replayOf };
      if (routeTenantId) session = routeTenantId;
      return { allowed: true, replay: false, notifyLimit: false, tenantId: session };
    }),
  };
  return { deps: deps satisfies DemoDeps, ...deps };
}
const msg = (text?: string) => ({ from: PHONE, providerMsgId: "wamid.1", channelId: CHANNEL, deskTenantId: DESK, ...(text === undefined ? {} : { text }) });

describe("routing a message to the demo number", () => {
  it("counts every message against the daily limit of 30, with the business of a valid code", async () => {
    const f = fakes();
    await routeDemoMessage(msg("DEMO-SALON"), f.deps);
    expect(DEMO_DAILY_LIMIT).toBe(30);
    expect(f.admit).toHaveBeenCalledWith({ phone: PHONE, wamid: "wamid.1", limit: 30, routeTenantId: A });
    await routeDemoMessage(msg("hello"), f.deps);
    expect(f.admit).toHaveBeenLastCalledWith({ phone: PHONE, wamid: "wamid.1", limit: 30, routeTenantId: null });
  });

  it("routes by a demo code, takes the code out of the text, and asks nobody about a trial phone", async () => {
    const f = fakes();
    expect(await routeDemoMessage(msg("DEMO-SALON haircut price?"), f.deps)).toEqual({ action: "store", tenantId: A, body: "haircut price?", routeCode: "DEMO-SALON" });
    expect(f.claimTrialPhone).not.toHaveBeenCalled();
  });

  it("a code beats an older route: the visitor can try another business", async () => {
    expect(await routeDemoMessage(msg("DEMO-INTERIORS"), fakes({ session: A }).deps)).toMatchObject({ action: "store", tenantId: C });
  });

  it("without a code, keeps the visitor with the business of their route, and the text as sent", async () => {
    const f = fakes({ session: A });
    expect(await routeDemoMessage(msg("what are your timings?"), f.deps)).toEqual({ action: "store", tenantId: A });
    expect(f.findRoute).not.toHaveBeenCalled();
  });

  it("a message with no text (a photo, a voice note) follows the route too", async () => {
    expect(await routeDemoMessage(msg(), fakes({ session: A }).deps)).toEqual({ action: "store", tenantId: A });
  });

  it("a later message in a session on a trial business (no code in the text) is stored for it and never asks about the trial phone again: the claim was made on the message that carried the TRIAL code", async () => {
    for (const text of ["what are your timings?", undefined]) {
      const f = fakes({ session: B });
      expect(await routeDemoMessage(msg(text), f.deps)).toEqual({ action: "store", tenantId: B });
      expect(f.claimTrialPhone).not.toHaveBeenCalled();
      expect(f.findRoute).not.toHaveBeenCalled();
    }
  });
});

describe("the daily limit", () => {
  it("the message that crosses it is refused and gets the limit notice, in the visitor's language", async () => {
    const f = fakes({ allowed: false, notifyLimit: true });
    expect(await routeDemoMessage(msg("hello"), f.deps)).toEqual({ action: "drop", reason: "limit", reply: { kind: "limit", lang: "en" } });
    expect(await routeDemoMessage(msg("வணக்கம்"), f.deps)).toEqual({ action: "drop", reason: "limit", reply: { kind: "limit", lang: "ta" } });
    expect(await routeDemoMessage(msg("price enna"), f.deps)).toEqual({ action: "drop", reason: "limit", reply: { kind: "limit", lang: "tanglish" } });
  });

  it("every later message is refused in silence", async () => {
    expect(await routeDemoMessage(msg("DEMO-SALON"), fakes({ allowed: false }).deps)).toEqual({ action: "drop", reason: "limit" });
  });
});

describe("a trial code", () => {
  it("asks whether the sender may have it, with the business of the trial and the sender's number, before the message is counted", async () => {
    const f = fakes();
    const order: string[] = [];
    f.claimTrialPhone.mockImplementation(async () => (order.push("claim"), "claimed"));
    f.admit.mockImplementation(async () => (order.push("admit"), { allowed: true, replay: false, notifyLimit: false, tenantId: B }));
    expect(await routeDemoMessage(msg("Hi TRIAL-7F3K"), f.deps)).toMatchObject({ action: "store", tenantId: B, body: "Hi", routeCode: "TRIAL-7F3K" });
    expect(f.claimTrialPhone).toHaveBeenCalledWith(B, PHONE);
    expect(order).toEqual(["claim", "admit"]);
  });

  it("the trial's own phone ('claimed') and someone else trying the trial ('other_sender') are routed as usual", async () => {
    for (const claim of ["claimed", "other_sender"] as const) {
      const f = fakes({ claim });
      expect(await routeDemoMessage(msg("TRIAL-7F3K"), f.deps)).toMatchObject({ action: "store", tenantId: B });
      expect(f.admit).toHaveBeenCalledWith(expect.objectContaining({ routeTenantId: B }));
    }
  });

  it("a sender who already used a trial ('taken') starts no route: the message is counted, dropped, and answered with a short refusal", async () => {
    const f = fakes({ claim: "taken", session: A });
    expect(await routeDemoMessage(msg("TRIAL-7F3K"), f.deps)).toEqual({ action: "drop", reason: "trial_taken", reply: { kind: "trial_taken", lang: "en" } });
    expect(f.admit).toHaveBeenCalledWith(expect.objectContaining({ routeTenantId: null }));
  });

  it("the refusal comes in the visitor's language", async () => {
    expect(await routeDemoMessage(msg("TRIAL-7F3K venum"), fakes({ claim: "taken" }).deps)).toMatchObject({ reply: { kind: "trial_taken", lang: "tanglish" } });
  });

  it("a refused trial that also crosses the daily limit is a limit, with its notice if it is the one", async () => {
    const f = fakes({ claim: "taken", allowed: false, notifyLimit: true });
    expect(await routeDemoMessage(msg("TRIAL-7F3K"), f.deps)).toEqual({ action: "drop", reason: "limit", reply: { kind: "limit", lang: "en" } });
  });

  it("an error from the claim is thrown, so the webhook answers 500 and Meta tries again: nothing is counted or routed", async () => {
    const f = fakes();
    f.claimTrialPhone.mockRejectedValueOnce(new Error("down"));
    await expect(routeDemoMessage(msg("TRIAL-7F3K"), f.deps)).rejects.toThrow("down");
    expect(f.admit).not.toHaveBeenCalled();
  });

  it("a trial that is not live is not claimed against: the code just leads nowhere", async () => {
    const f = fakes({ dead: [B] });
    expect(await routeDemoMessage(msg("TRIAL-7F3K"), f.deps)).toMatchObject({ action: "drop", reason: "bad_code" });
    expect(f.claimTrialPhone).not.toHaveBeenCalled();
  });
});

describe("two messages from one phone at the same moment, each with a TRIAL code", () => {
  const T1 = "e1000000-0000-4000-8000-0000000000e1";
  const T2 = "e2000000-0000-4000-8000-0000000000e2";

  /**
   * Dev 2's claim_trial_phone as its migration (0033) defines it, one claim at a time like the database does (its unique keys make a second claim wait for the
   * first), with a pause before each so the two calls really interleave. The real function under real parallel sessions is checked by
   * backend/src/scripts/trial-claim-race.ts.
   */
  function race() {
    const phoneOwner = new Map<string, string>(); // phone -> trial
    const trialPhone = new Map<string, string>(); // trial -> phone
    const counted: string[] = [];
    const claim = async (tenantId: string, phone: string): Promise<Claim> => {
      await Promise.resolve();
      await Promise.resolve();
      if (!phoneOwner.has(phone) && !trialPhone.has(tenantId)) {
        phoneOwner.set(phone, tenantId);
        trialPhone.set(tenantId, phone);
        return "claimed";
      }
      if (phoneOwner.get(phone) === tenantId) return "claimed";
      return trialPhone.has(tenantId) ? "other_sender" : "taken";
    };
    const f = fakes({ routes: { "TRIAL-AAAA": { tenantId: T1, kind: "trial" }, "TRIAL-BBBB": { tenantId: T2, kind: "trial" } } });
    f.claimTrialPhone.mockImplementation(claim);
    f.admit.mockImplementation(async ({ routeTenantId, wamid }) => {
      counted.push(wamid);
      return { allowed: true, replay: false, notifyLimit: false, tenantId: routeTenantId };
    });
    return { f, counted, claimed: () => [...phoneOwner.entries()] };
  }
  const message = (text: string, wamid: string) => ({ ...msg(text), providerMsgId: wamid });

  it("two different trials: one is routed, the other is refused with the trial_taken answer, whichever arrives first; each message is counted once and the phone is claimed once", async () => {
    for (const order of ["ab", "ba"]) {
      const r = race();
      const a = message("Hi TRIAL-AAAA", "wamid.a");
      const b = message("Hi TRIAL-BBBB", "wamid.b");
      const decisions = await Promise.all((order === "ab" ? [a, b] : [b, a]).map((m) => routeDemoMessage(m, r.f.deps)));
      const stored = decisions.filter((d) => d.action === "store");
      const refused = decisions.filter((d) => d.action === "drop");
      expect(stored).toHaveLength(1);
      expect(refused).toEqual([{ action: "drop", reason: "trial_taken", reply: { kind: "trial_taken", lang: "en" } }]);
      expect(r.claimed()).toHaveLength(1);
      expect(r.claimed()[0][1]).toBe(stored[0].action === "store" ? stored[0].tenantId : "");
      expect(r.counted.sort()).toEqual(["wamid.a", "wamid.b"]);
      expect(r.f.admit).toHaveBeenCalledTimes(2);
      // the refused message was counted without a route: it started none
      expect(r.f.admit.mock.calls.filter(([args]) => args.routeTenantId === null)).toHaveLength(1);
    }
  });

  it("the same trial twice: both are routed (the claim is idempotent), the phone is claimed once, each message is counted once", async () => {
    const r = race();
    const decisions = await Promise.all([routeDemoMessage(message("Hi TRIAL-AAAA", "wamid.a"), r.f.deps), routeDemoMessage(message("again TRIAL-AAAA", "wamid.b"), r.f.deps)]);
    expect(decisions.map((d) => d.action)).toEqual(["store", "store"]);
    expect(decisions.every((d) => d.action === "store" && d.tenantId === T1)).toBe(true);
    expect(r.claimed()).toEqual([[PHONE, T1]]);
    expect(r.counted.sort()).toEqual(["wamid.a", "wamid.b"]);
  });

  it("two phones for one trial: the first is the trial's phone and the other is routed as someone trying it, both counted once", async () => {
    const r = race();
    const other = { ...message("Hi TRIAL-AAAA", "wamid.b"), from: "+919800000002" };
    const decisions = await Promise.all([routeDemoMessage(message("Hi TRIAL-AAAA", "wamid.a"), r.f.deps), routeDemoMessage(other, r.f.deps)]);
    expect(decisions.map((d) => d.action)).toEqual(["store", "store"]);
    expect(r.claimed()).toHaveLength(1);
    expect(r.counted.sort()).toEqual(["wamid.a", "wamid.b"]);
  });
});

describe("a code that leads nowhere", () => {
  it("an unknown or expired code is dropped with the 'invalid or expired' answer, even for a visitor with a route, and starts no route", async () => {
    const f = fakes({ session: A, routes: {} });
    expect(await routeDemoMessage(msg("DEMO-SALON"), f.deps)).toEqual({ action: "drop", reason: "bad_code", reply: { kind: "bad_code", lang: "en" } });
    expect(f.admit).toHaveBeenCalledWith(expect.objectContaining({ routeTenantId: null }));
  });

  it("a code of a business that is paused or cancelled is the same", async () => {
    expect(await routeDemoMessage(msg("DEMO-SALON"), fakes({ dead: [A] }).deps)).toMatchObject({ action: "drop", reason: "bad_code", reply: { kind: "bad_code" } });
  });
});

describe("a visitor with no route and no code", () => {
  it("gets the menu, in their language, and nothing is routed", async () => {
    const f = fakes();
    expect(await routeDemoMessage(msg("hello"), f.deps)).toEqual({ action: "drop", reason: "no_route", reply: { kind: "menu", lang: "en" } });
    expect(await routeDemoMessage(msg("வணக்கம்"), f.deps)).toMatchObject({ reply: { kind: "menu", lang: "ta" } });
    expect(await routeDemoMessage(msg("vanakkam"), f.deps)).toMatchObject({ reply: { kind: "menu", lang: "tanglish" } });
    expect(await routeDemoMessage(msg(), f.deps)).toMatchObject({ reply: { kind: "menu", lang: "en" } });
  });

  it("a route to a business that has since been paused or cancelled is no route: the menu", async () => {
    expect(await routeDemoMessage(msg("what are your timings?"), fakes({ session: A, dead: [A] }).deps)).toMatchObject({ action: "drop", reason: "no_route", reply: { kind: "menu" } });
  });
});

describe("a menu pick", () => {
  it("a number picks the business of that entry, like sending its code: the route starts, and the assistant is greeted", async () => {
    const f = fakes();
    expect(await routeDemoMessage(msg("2"), f.deps)).toEqual({ action: "store", tenantId: A, body: "Hi", routeCode: "DEMO-SALON" });
    expect(f.findRoute).toHaveBeenCalledWith("DEMO-SALON");
    expect(f.admit).toHaveBeenCalledWith(expect.objectContaining({ routeTenantId: A }));
  });

  it("the entry's own word picks it too", async () => {
    expect(await routeDemoMessage(msg("Beauty parlour"), fakes().deps)).toMatchObject({ action: "store", tenantId: A, routeCode: "DEMO-SALON" });
    expect(await routeDemoMessage(msg("interiors"), fakes().deps)).toMatchObject({ action: "store", tenantId: C, routeCode: "DEMO-INTERIORS" });
  });

  it("is only for a visitor with no route: with one, a bare number is an answer to the assistant, and nothing is read for it", async () => {
    const f = fakes({ session: A });
    expect(await routeDemoMessage(msg("2"), f.deps)).toEqual({ action: "store", tenantId: A });
    expect(f.menu).not.toHaveBeenCalled();
    expect(f.findRoute).not.toHaveBeenCalled();
  });

  it("a number that is not on the list gets the menu again", async () => {
    expect(await routeDemoMessage(msg("7"), fakes().deps)).toMatchObject({ action: "drop", reason: "no_route", reply: { kind: "menu" } });
  });

  it("an entry whose code has expired or whose business is not live is not picked: the menu again, never an 'invalid code'", async () => {
    expect(await routeDemoMessage(msg("2"), fakes({ routes: {} }).deps)).toMatchObject({ reply: { kind: "menu" }, reason: "no_route" });
    expect(await routeDemoMessage(msg("2"), fakes({ dead: [A] }).deps)).toMatchObject({ reply: { kind: "menu" }, reason: "no_route" });
  });

  it("a long message is never a pick, and the menu is not read for it", async () => {
    const f = fakes();
    expect(await routeDemoMessage(msg("2 ".repeat(40)), f.deps)).toMatchObject({ action: "drop", reason: "no_route" });
    expect(f.menu).not.toHaveBeenCalled();
    expect(f.hasRoute).not.toHaveBeenCalled();
  });

  it("an explicit code wins over a pick, and a photo is never a pick", async () => {
    const f = fakes();
    expect(await routeDemoMessage(msg("DEMO-INTERIORS"), f.deps)).toMatchObject({ tenantId: C });
    expect(f.menu).not.toHaveBeenCalled();
    expect(await routeDemoMessage(msg(), fakes().deps)).toMatchObject({ action: "drop", reason: "no_route" });
  });
});

describe("a redelivered message", () => {
  it("one already stored with a business is stored for that business again, even if it carried a code that no longer works or the route has moved since", async () => {
    const f = fakes({ replayOf: C, holder: A, routes: {} });
    expect(await routeDemoMessage(msg("DEMO-SALON hello"), f.deps)).toEqual({ action: "store", tenantId: A, body: "hello", routeCode: "DEMO-SALON" });
    expect(await routeDemoMessage(msg("hello"), f.deps)).toEqual({ action: "store", tenantId: A });
    expect(f.messageTenant).toHaveBeenCalledWith({ providerMsgId: "wamid.1", channelId: CHANNEL });
  });

  it("one that was dropped with an answer, from a visitor who has a route, is dropped and answered again: never stored for the route's business (the id is the front desk's)", async () => {
    const f = fakes({ session: A, replayOf: A, holder: DESK, routes: {} });
    expect(await routeDemoMessage(msg("DEMO-ZZZ"), f.deps)).toEqual({ action: "drop", reason: "bad_code", reply: { kind: "bad_code", lang: "en" } });
    const plain = fakes({ session: A, replayOf: A, holder: DESK });
    expect(await routeDemoMessage(msg("hello"), plain.deps)).toEqual({ action: "drop", reason: "no_route", reply: { kind: "menu", lang: "en" } });
  });

  it("a trial refusal that was dropped is refused again", async () => {
    const f = fakes({ claim: "taken", replayOf: null, holder: DESK });
    expect(await routeDemoMessage(msg("TRIAL-7F3K"), f.deps)).toEqual({ action: "drop", reason: "trial_taken", reply: { kind: "trial_taken", lang: "en" } });
  });

  it("one that was never stored (the first delivery failed before it) is decided as if new: a bad code is a bad code even for a visitor with a route", async () => {
    const f = fakes({ session: A, replayOf: A, holder: null, routes: {} });
    expect(await routeDemoMessage(msg("DEMO-ZZZ"), f.deps)).toEqual({ action: "drop", reason: "bad_code", reply: { kind: "bad_code", lang: "en" } });
  });

  it("one never stored and with no code goes to the business it was admitted for", async () => {
    expect(await routeDemoMessage(msg("hello"), fakes({ replayOf: A, holder: null }).deps)).toEqual({ action: "store", tenantId: A });
  });

  it("one that was admitted for no business and not stored is answered with the menu again (the reply itself is not repeated: its event id is the message's)", async () => {
    expect(await routeDemoMessage(msg("hello"), fakes({ replayOf: null }).deps)).toMatchObject({ action: "drop", reason: "no_route", reply: { kind: "menu" } });
  });

  it("is looked up only for a redelivery", async () => {
    const f = fakes();
    await routeDemoMessage(msg("DEMO-SALON"), f.deps);
    expect(f.messageTenant).not.toHaveBeenCalled();
  });
});

describe("a visitor who asks not to be written to", () => {
  it("is not answered when they have no route: no menu, nothing to send", async () => {
    for (const text of ["STOP", "stop", "Unsubscribe", "message panna vendam", "மெசேஜ் அனுப்பாதீங்க"]) {
      expect(await routeDemoMessage(msg(text), fakes().deps)).toEqual({ action: "drop", reason: "no_route" });
    }
  });

  it("with a route it is the business's own opt-out, handled by its pipeline: the message is stored for it", async () => {
    expect(await routeDemoMessage(msg("STOP"), fakes({ session: A }).deps)).toEqual({ action: "store", tenantId: A });
  });

  it("an ordinary message that mentions stopping is still answered", async () => {
    expect(await routeDemoMessage(msg("bus stop near the project?"), fakes().deps)).toMatchObject({ reply: { kind: "menu" } });
  });
});

describe("failures", () => {
  it("every database step lets its error through, so the webhook answers 500 and Meta retries", async () => {
    for (const step of ["findRoute", "isLive", "admit", "claimTrialPhone", "hasRoute", "menu"] as const) {
      const f = fakes();
      f[step].mockRejectedValueOnce(new Error("down"));
      const text = step === "hasRoute" || step === "menu" ? "2" : "TRIAL-7F3K";
      await expect(routeDemoMessage(msg(text), f.deps)).rejects.toThrow("down");
    }
  });
});

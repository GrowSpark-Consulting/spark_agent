import { describe, expect, it } from "vitest";
import { agentMeta, MON_17, NOW, OFFER, plain, ready, runner, SUN_15, understood, world } from "../../test-support/booking-world";
import type { QualificationSummary } from "./understand";
import { replyTurn } from "./reply";

// A visit to the customer's address (the pack books field visits): the times offered are only those of someone who works in the customer's
// pincode, which Dev 2's findSlots filters (booking/bookings.ts, `pincode`). The pincode is read from the lead's own detail that the pack's
// area rule names (QualificationSummary.visitAreaField, a detail's name), never from a name in code, and it is never kept in a step result.

const visit: QualificationSummary = { ...ready, bookingKind: "field_visit", visitAreaField: "zip" };
const text = "Sunday at 10:00 am works for us.";

describe("the pincode of a field visit reaches the booking engine", () => {
  it("is the lead's own pincode, as digits (typed with a space or a dash it is still the same pincode)", async () => {
    for (const typed of ["600042", "600 042", "600-042"]) {
      const w = world({ script: [text], leadFields: { zip: typed } });
      await replyTurn(runner().step, w.turn, understood({}, visit), NOW, w.deps);
      expect(w.port.findSlots.mock.calls[0][1].pincode, typed).toBe("600042");
    }
  });

  it("is not sent when the customer has not given one, or what they gave is not a six-digit pincode", async () => {
    for (const fields of [{}, { zip: "Adyar" }, { zip: "6000" }, { zip: 600042.5 }, { zip: null }]) {
      const w = world({ script: [text], leadFields: fields });
      await replyTurn(runner().step, w.turn, understood({}, visit), NOW, w.deps);
      expect(Object.keys(w.port.findSlots.mock.calls[0][1]), JSON.stringify(fields)).not.toContain("pincode");
    }
  });

  it("is not sent for a booking that does not go to the customer's address, even when the lead holds a pincode", async () => {
    const w = world({ script: [text], leadFields: { zip: "600042" } });
    await replyTurn(runner().step, w.turn, understood({}, ready), NOW, w.deps);
    expect(Object.keys(w.port.findSlots.mock.calls[0][1])).not.toContain("pincode");
  });

  it("is never kept on the message (the offer, the act result, the plan row): only the times are", async () => {
    const w = world({ script: [text], leadFields: { zip: "600042" } });
    await replyTurn(runner().step, w.turn, understood({}, visit), NOW, w.deps);
    expect(JSON.stringify(agentMeta(w))).not.toContain("600042");
  });

  it("a pincode nobody works in: no time is offered and a person takes over, as for any day with nothing free", async () => {
    const w = world({ leadFields: { zip: "641001" }, port: { findSlots: async (_t, input) => (input.pincode === "641001" ? [] : [plain(SUN_15) as never]) } });
    const out = await replyTurn(runner().step, w.turn, understood({}, visit), NOW, w.deps);
    expect(out).toMatchObject({ case: "no_slots", handoff: { trigger: "stuck" } });
  });

  it("books the time the customer picked as a field visit", async () => {
    const w = world({ offer: { ...OFFER, slots: [SUN_15, MON_17].map(plain) }, text: "the first one", script: ["Booked."], leadFields: { zip: "600042" } });
    await replyTurn(runner().step, w.turn, understood({}, visit), NOW, w.deps);
    expect(w.port.holdSlot).toHaveBeenCalledWith(expect.any(String), plain(SUN_15), expect.any(String), "field_visit");
  });
});

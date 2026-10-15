import { describe, expect, it } from "vitest";
import { AppError } from "../lib/errors";
import { createCalendar } from "./calendar";

const T = "e0000000-0000-0000-0000-00000000000a";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const SERVICE = "30000000-0000-0000-0000-000000000003";
const NOW = "2026-10-10T04:30:00.000Z"; // Sat 10 Oct, 10:00 in Chennai
const SUN_10 = "2026-10-11T04:30:00.000Z";
const SUN_15 = "2026-10-11T09:30:00.000Z";
const MON_17 = "2026-10-12T12:00:00.000Z";
const window = (from: string, to: string) => ({ serviceId: SERVICE, from: new Date(from), to: new Date(to) });

function calendar(over: Partial<Parameters<typeof createCalendar>[0]> = {}) {
  const confirmedFor: string[] = [];
  const cal = createCalendar({ now: NOW, timeZone: "Asia/Kolkata", slots: [SUN_10, SUN_15, MON_17], takenWhenChosen: [], onConfirm: () => confirmedFor.push("yes"), ...over });
  return { cal, confirmedFor };
}

describe("the free times a chat can be offered", () => {
  it("only those inside the window asked for, soonest first, up to three, labelled in the business's own time zone", async () => {
    const { cal } = calendar();
    const found = await cal.port.findSlots(T, window("2026-10-11T00:00:00.000Z", "2026-10-13T00:00:00.000Z"));
    expect(found.map((s) => s.label)).toEqual(["Sun 11 Oct, 10:00 am", "Sun 11 Oct, 3:00 pm", "Mon 12 Oct, 5:30 pm"]);
    expect(found[0]).toMatchObject({ start: SUN_10, end: "2026-10-11T05:30:00.000Z", serviceId: SERVICE });
    expect((await cal.port.findSlots(T, window("2026-10-11T00:00:00.000Z", "2026-10-11T07:00:00.000Z"))).map((s) => s.start)).toEqual([SUN_10]);
    expect(await cal.port.findSlots(T, window("2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z"))).toEqual([]);
  });

  it("never offers a time that has passed", async () => {
    const { cal } = calendar({ slots: ["2026-10-10T03:00:00.000Z", SUN_10] });
    expect((await cal.port.findSlots(T, window("2026-10-10T00:00:00.000Z", "2026-10-12T00:00:00.000Z"))).map((s) => s.start)).toEqual([SUN_10]);
  });
});

describe("holding and confirming", () => {
  it("a held and confirmed time is the customer's, no longer free, and moves the lead to booked", async () => {
    const { cal, confirmedFor } = calendar();
    const held = await cal.port.holdSlot(T, { start: SUN_15, end: "2026-10-11T10:30:00.000Z", resourceId: "r", serviceId: SERVICE, label: "x" }, LEAD, "site_visit");
    await cal.port.confirmBooking(T, held.id);
    expect(cal.confirmed()).toEqual([SUN_15]);
    expect(confirmedFor).toHaveLength(1);
    expect((await cal.port.findSlots(T, window("2026-10-11T00:00:00.000Z", "2026-10-13T00:00:00.000Z"))).map((s) => s.start)).toEqual([SUN_10, MON_17]);
    expect(await cal.port.activeBooking(T, LEAD)).toMatchObject({ start: SUN_15, status: "confirmed" });
  });

  it("a time someone else takes when it is chosen is taken, once, and is no longer free", async () => {
    const { cal } = calendar({ takenWhenChosen: [SUN_15] });
    const slot = { start: SUN_15, end: "2026-10-11T10:30:00.000Z", resourceId: "r", serviceId: SERVICE, label: "x" };
    await expect(cal.port.holdSlot(T, slot, LEAD, "site_visit")).rejects.toMatchObject({ code: "slot_taken" });
    await expect(cal.port.holdSlot(T, slot, LEAD, "site_visit")).rejects.toBeInstanceOf(AppError);
    expect(cal.confirmed()).toEqual([]);
    expect((await cal.port.findSlots(T, window("2026-10-11T00:00:00.000Z", "2026-10-13T00:00:00.000Z"))).map((s) => s.start)).toEqual([SUN_10, MON_17]);
  });

  it("a hold that is not confirmed is a hold, not a booking that can be moved or cancelled", async () => {
    const { cal } = calendar();
    await cal.port.holdSlot(T, { start: SUN_10, end: "2026-10-11T05:30:00.000Z", resourceId: "r", serviceId: SERVICE, label: "x" }, LEAD, "site_visit");
    expect(cal.confirmed()).toEqual([]);
    expect(await cal.port.activeBooking(T, LEAD)).toMatchObject({ status: "held" });
  });
});

describe("a booking the customer already has", () => {
  it("is confirmed from the start, and is not offered to anyone else", async () => {
    const { cal } = calendar({ existing: SUN_15 });
    expect(cal.confirmed()).toEqual([SUN_15]);
    expect(await cal.port.activeBooking(T, LEAD)).toMatchObject({ start: SUN_15, status: "confirmed" });
    expect((await cal.port.findSlots(T, window("2026-10-11T00:00:00.000Z", "2026-10-13T00:00:00.000Z"))).map((s) => s.start)).toEqual([SUN_10, MON_17]);
  });

  it("is moved to a free time, and its old time is free again", async () => {
    const { cal } = calendar({ existing: SUN_15 });
    const booking = await cal.port.activeBooking(T, LEAD);
    await cal.port.rescheduleBooking(T, booking!.id, { start: MON_17, end: "2026-10-12T13:00:00.000Z", resourceId: "r", serviceId: SERVICE, label: "x" });
    expect(cal.confirmed()).toEqual([MON_17]);
    expect((await cal.port.findSlots(T, window("2026-10-11T00:00:00.000Z", "2026-10-13T00:00:00.000Z"))).map((s) => s.start)).toEqual([SUN_10, SUN_15]);
  });

  it("is not moved to a time that is not free", async () => {
    const { cal } = calendar({ existing: SUN_15 });
    const booking = await cal.port.activeBooking(T, LEAD);
    await expect(cal.port.rescheduleBooking(T, booking!.id, { start: SUN_15, end: "2026-10-11T10:30:00.000Z", resourceId: "r", serviceId: SERVICE, label: "x" })).rejects.toMatchObject({ code: "slot_taken" });
  });

  it("is cancelled, counted, and its time is free again; cancelling twice is harmless", async () => {
    const { cal } = calendar({ existing: SUN_15 });
    const booking = await cal.port.activeBooking(T, LEAD);
    await cal.port.cancelBooking(T, booking!.id, "asked");
    await cal.port.cancelBooking(T, booking!.id, "asked");
    expect(cal.confirmed()).toEqual([]);
    expect(cal.cancelled()).toBe(1);
    expect(await cal.port.activeBooking(T, LEAD)).toBeNull();
    expect((await cal.port.findSlots(T, window("2026-10-11T00:00:00.000Z", "2026-10-13T00:00:00.000Z"))).map((s) => s.start)).toContain(SUN_15);
  });
});

describe("the pincodes the chat's technician works in (a field visit goes to the customer's address)", () => {
  const all = window("2026-10-11T00:00:00.000Z", "2026-10-13T00:00:00.000Z");

  it("with no list, the technician works everywhere: a pincode filters nothing (as a resource with no service area in Dev 2's findSlots)", async () => {
    const { cal } = calendar();
    expect(await cal.port.findSlots(T, { ...all, pincode: "641001" })).toHaveLength(3);
  });

  it("with a list, a pincode in it gets the times, and one outside it gets none", async () => {
    const { cal } = calendar({ workPincodes: ["600042", "600020"] });
    expect(await cal.port.findSlots(T, { ...all, pincode: "600042" })).toHaveLength(3);
    expect(await cal.port.findSlots(T, { ...all, pincode: "641001" })).toEqual([]);
  });

  it("with a list and no pincode given, the times are offered (Dev 2's findSlots filters only when it is asked to)", async () => {
    const { cal } = calendar({ workPincodes: ["600042"] });
    expect(await cal.port.findSlots(T, all)).toHaveLength(3);
  });
});

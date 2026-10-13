import { afterEach, describe, expect, it, vi } from "vitest";
import { SEND_TIMEOUT_MS, sendConnectedEvent } from "./connected-event";

// `whatsapp/connected` (docs/contracts.md, section 5): ids only, one event per connection and check time, best effort.

const CONNECTION = { id: "d0000000-0000-4000-8000-0000000000d1", tenant_id: "a0000000-0000-4000-8000-00000000000a" };
const RAN_AT = "2026-10-14T00:00:00.000Z";

describe("sendConnectedEvent", () => {
  it("sends the event with ids only, and an id that holds the connection and the check's time", async () => {
    const send = vi.fn(async () => {});
    await sendConnectedEvent(send, CONNECTION, RAN_AT);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      name: "whatsapp/connected",
      id: `whatsapp_connected:${CONNECTION.id}:${RAN_AT}`,
      data: { tenantId: CONNECTION.tenant_id, connectionId: CONNECTION.id },
    });
  });

  it("a later check of the same connection is a new event, the same check is the same id", async () => {
    const ids: string[] = [];
    const send = vi.fn(async (event: { id: string }) => void ids.push(event.id));
    await sendConnectedEvent(send, CONNECTION, RAN_AT);
    await sendConnectedEvent(send, CONNECTION, RAN_AT);
    await sendConnectedEvent(send, CONNECTION, "2026-10-14T00:05:00.000Z");
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("never throws: a send that fails is logged with a fixed line and nothing else", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    await expect(sendConnectedEvent(async () => Promise.reject(new Error("inngest down: secret-ish detail")), CONNECTION, RAN_AT)).resolves.toBeUndefined();
    expect(logs).toEqual(["[whatsapp-connect] the connected event could not be sent"]);
    spy.mockRestore();
  });

  describe("a slow Inngest", () => {
    afterEach(() => vi.useRealTimers());

    it("is not waited for longer than the limit: the caller goes on, with the fixed log line", async () => {
      vi.useFakeTimers();
      const logs: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
      let finished = false;
      const done = sendConnectedEvent(() => new Promise(() => {}), CONNECTION, RAN_AT).then(() => (finished = true));
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await done;
      expect(finished).toBe(true);
      expect(logs).toEqual(["[whatsapp-connect] the connected event could not be sent"]);
      spy.mockRestore();
    });

    it("a send that finishes in time leaves no timer behind and logs nothing", async () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await sendConnectedEvent(async () => {}, CONNECTION, RAN_AT);
      expect(vi.getTimerCount()).toBe(0);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("a send that fails after the wait is over is not an unhandled rejection", async () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      let fail: (e: Error) => void = () => {};
      const done = sendConnectedEvent(() => new Promise((_resolve, reject) => (fail = reject)), CONNECTION, RAN_AT);
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
      await done;
      fail(new Error("late"));
      await vi.advanceTimersByTimeAsync(10);
      spy.mockRestore();
    });
  });

  it("does nothing when there is no sender", async () => {
    await expect(sendConnectedEvent(undefined, CONNECTION, RAN_AT)).resolves.toBeUndefined();
  });
});

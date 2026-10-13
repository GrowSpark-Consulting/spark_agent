import { describe, expect, it, vi } from "vitest";
import { DEMO_DAILY_LIMIT, routeDemoMessage, type DemoDeps } from "./route";

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const PHONE = "+919800000001";

type Admit = { allowed: boolean; replay: boolean; tenantId: string | null };

/**
 * The fake database behaves like demo_admit for what the rules need: a valid code's business is the message's business and
 * becomes the visitor's route; otherwise the route is; a replay answers with the business it was first admitted for.
 */
function fakes(over: { session?: string | null; routes?: Record<string, string>; allowed?: boolean; replayOf?: string | null; dead?: string[] } = {}) {
  const routes = over.routes ?? { "DEMO-SALON": A, "TRIAL-7F3K": B };
  let session = over.session ?? null;
  const deps = {
    findRoute: vi.fn(async (code: string) => (routes[code] ? { tenantId: routes[code] } : null)),
    isLive: vi.fn(async (tenantId: string) => !(over.dead ?? []).includes(tenantId)),
    admit: vi.fn(async ({ routeTenantId }: { routeTenantId: string | null }): Promise<Admit> => {
      if (over.allowed === false) return { allowed: false, replay: false, tenantId: null };
      if (over.replayOf !== undefined) return { allowed: true, replay: true, tenantId: over.replayOf };
      if (routeTenantId) session = routeTenantId;
      return { allowed: true, replay: false, tenantId: session };
    }),
  };
  return { deps: deps satisfies DemoDeps, ...deps };
}
const msg = (text?: string) => ({ from: PHONE, providerMsgId: "wamid.1", ...(text === undefined ? {} : { text }) });

describe("routing a message to the demo number", () => {
  it("counts every message against the daily limit of 30, with the business of a valid code", async () => {
    const f = fakes();
    await routeDemoMessage(msg("DEMO-SALON"), f.deps);
    expect(DEMO_DAILY_LIMIT).toBe(30);
    expect(f.admit).toHaveBeenCalledWith({ phone: PHONE, wamid: "wamid.1", limit: 30, routeTenantId: A });
    await routeDemoMessage(msg("hello"), f.deps);
    expect(f.admit).toHaveBeenLastCalledWith({ phone: PHONE, wamid: "wamid.1", limit: 30, routeTenantId: null });
  });

  it("drops a message over the limit", async () => {
    const f = fakes({ allowed: false });
    expect(await routeDemoMessage(msg("DEMO-SALON"), f.deps)).toEqual({ action: "drop", reason: "limit" });
  });

  it("routes by a demo code and takes the code out of the text", async () => {
    const f = fakes();
    expect(await routeDemoMessage(msg("DEMO-SALON haircut price?"), f.deps)).toEqual({ action: "store", tenantId: A, body: "haircut price?", routeCode: "DEMO-SALON" });
    expect(f.findRoute).toHaveBeenCalledWith("DEMO-SALON");
  });

  it("routes by a trial code to that trial's business", async () => {
    expect(await routeDemoMessage(msg("Hi TRIAL-7F3K"), fakes().deps)).toMatchObject({ action: "store", tenantId: B, body: "Hi", routeCode: "TRIAL-7F3K" });
  });

  it("a code beats an older route: the visitor can try another business", async () => {
    expect(await routeDemoMessage(msg("TRIAL-7F3K"), fakes({ session: A }).deps)).toMatchObject({ action: "store", tenantId: B });
  });

  it("without a code, keeps the visitor with the business of their route, and the text as sent", async () => {
    const f = fakes({ session: A });
    expect(await routeDemoMessage(msg("what are your timings?"), f.deps)).toEqual({ action: "store", tenantId: A });
    expect(f.findRoute).not.toHaveBeenCalled();
  });

  it("a message with no text (a photo, a voice note) follows the route too", async () => {
    expect(await routeDemoMessage(msg(), fakes({ session: A }).deps)).toEqual({ action: "store", tenantId: A });
  });

  it("with no code and no route, stores and answers nothing", async () => {
    const f = fakes();
    expect(await routeDemoMessage(msg("hello"), f.deps)).toEqual({ action: "drop", reason: "no_route" });
    expect(await routeDemoMessage(msg(), f.deps)).toEqual({ action: "drop", reason: "no_route" });
  });

  it("an unknown or expired code (the lookup says none) is dropped, even for a visitor with a route", async () => {
    const f = fakes({ session: A, routes: {} });
    expect(await routeDemoMessage(msg("DEMO-SALON"), f.deps)).toEqual({ action: "drop", reason: "bad_code" });
    expect(f.admit).toHaveBeenCalledWith(expect.objectContaining({ routeTenantId: null })); // still counted, no route started
  });

  it("a code of a business that is paused or cancelled leads nowhere, and starts no route", async () => {
    const f = fakes({ dead: [A] });
    expect(await routeDemoMessage(msg("DEMO-SALON"), f.deps)).toEqual({ action: "drop", reason: "bad_code" });
    expect(f.admit).toHaveBeenCalledWith(expect.objectContaining({ routeTenantId: null }));
  });

  it("a route to a business that has since been paused or cancelled stores nothing", async () => {
    const f = fakes({ session: A, dead: [A] });
    expect(await routeDemoMessage(msg("what are your timings?"), f.deps)).toEqual({ action: "drop", reason: "no_route" });
  });

  it("a business that is live is asked about once for a code, and not at all again when the code named it", async () => {
    const f = fakes();
    await routeDemoMessage(msg("DEMO-SALON"), f.deps);
    expect(f.isLive).toHaveBeenCalledTimes(1);
  });

  it("a redelivered message goes to the business it was first admitted for, even if it carried a code that no longer works", async () => {
    const f = fakes({ replayOf: A, routes: {} });
    expect(await routeDemoMessage(msg("DEMO-SALON hello"), f.deps)).toEqual({ action: "store", tenantId: A, body: "hello", routeCode: "DEMO-SALON" });
    expect(await routeDemoMessage(msg("hello"), f.deps)).toEqual({ action: "store", tenantId: A });
  });

  it("a redelivered message that was admitted for no business is dropped again", async () => {
    expect(await routeDemoMessage(msg("hello"), fakes({ replayOf: null }).deps)).toEqual({ action: "drop", reason: "no_route" });
  });

  it("lets a database failure through, so the webhook answers 500 and Meta retries", async () => {
    for (const step of ["findRoute", "isLive", "admit"] as const) {
      const f = fakes();
      f[step].mockRejectedValueOnce(new Error("down"));
      await expect(routeDemoMessage(msg("DEMO-SALON"), f.deps)).rejects.toThrow("down");
    }
  });
});

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Service } from "@/features/knowledge/data";
import { chosenServiceId, describeBookingService, isSelectableChoice, readBookingService, saveBookingService } from "./booking-service";
import { SetupError } from "./resources-data";

const TENANT = "10000000-0000-4000-8000-000000000001";
const A = "20000000-0000-4000-8000-00000000000a";
const B = "20000000-0000-4000-8000-00000000000b";
const GONE = "20000000-0000-4000-8000-0000000000ff";

const service = (id: string, name: string, active = true): Service => ({ id, name, active }) as unknown as Service;

/**
 * A stand-in for the query builder that answers each awaited call, in order, from `results`, and records the calls.
 * `update` is recorded with its argument so a test can see exactly what was written.
 */
function fakeClient(results: { data: unknown; error: unknown }[]) {
  const calls: [string, unknown[]][] = [];
  const next = () => results[Math.min(calls.filter(([n]) => n === "from").length - 1, results.length - 1)];
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "update", "eq", "maybeSingle"]) {
    builder[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
  const client = {
    from: (table: string) => {
      calls.push(["from", [table]]);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("which service the assistant books (tenants.agent_settings.bookingServiceId)", () => {
  it("reads the chosen service id, and nothing when it is missing, not an id or the settings are another shape", () => {
    expect(chosenServiceId({ bookingServiceId: A, tone: "formal" })).toBe(A);
    expect(chosenServiceId({})).toBeNull();
    expect(chosenServiceId(null)).toBeNull();
    expect(chosenServiceId({ bookingServiceId: "Site visit" })).toBeNull();
    expect(chosenServiceId({ bookingServiceId: 7 })).toBeNull();
    expect(chosenServiceId("bookingServiceId")).toBeNull();
    expect(chosenServiceId([A])).toBeNull();
  });

  describe("what the section says", () => {
    it("asks for a service when there is none to book", () => {
      expect(describeBookingService([], null)).toEqual({ kind: "none" });
      expect(describeBookingService([service(A, "Site visit", false)], A)).toEqual({ kind: "none" });
    });

    it("books the only active service on its own, whatever was chosen", () => {
      const only = service(A, "Site visit");
      expect(describeBookingService([only, service(B, "Video call", false)], null)).toEqual({ kind: "only", service: only });
      expect(describeBookingService([only], GONE)).toEqual({ kind: "only", service: only });
    });

    it("needs a choice when several are active, and says when the chosen one is no longer active", () => {
      const a = service(A, "Site visit");
      const b = service(B, "Video call");
      expect(describeBookingService([a, b], null)).toEqual({ kind: "several", services: [a, b], chosen: null, stale: false });
      expect(describeBookingService([a, b], B)).toEqual({ kind: "several", services: [a, b], chosen: b, stale: false });
      expect(describeBookingService([a, b], GONE)).toEqual({ kind: "several", services: [a, b], chosen: null, stale: true });
      // A switched-off service is not offered, and a choice that points at one is stale.
      expect(describeBookingService([a, b, service(GONE, "Old", false)], GONE)).toEqual({ kind: "several", services: [a, b], chosen: null, stale: true });
    });
  });

  describe("reading", () => {
    it("reads the settings of the business and returns the chosen id", async () => {
      const { client, calls } = fakeClient([{ data: { id: TENANT, agent_settings: { bookingServiceId: A } }, error: null }]);
      expect(await readBookingService(client, TENANT)).toBe(A);
      expect(calls).toContainEqual(["from", ["tenants"]]);
      expect(calls).toContainEqual(["eq", ["id", TENANT]]);
    });

    it("answers null for a business with no settings or no choice", async () => {
      expect(await readBookingService(fakeClient([{ data: { id: TENANT, agent_settings: null }, error: null }]).client, TENANT)).toBeNull();
      expect(await readBookingService(fakeClient([{ data: { id: TENANT, agent_settings: {} }, error: null }]).client, TENANT)).toBeNull();
    });

    it("passes a database error on and rejects a row that isn't this business's", async () => {
      const pgError = { code: "42501", message: "permission denied", details: null, hint: null };
      await expect(readBookingService(fakeClient([{ data: null, error: pgError }]).client, TENANT)).rejects.toBe(pgError);
      await expect(readBookingService(fakeClient([{ data: { id: "nope" }, error: null }]).client, TENANT)).rejects.toBeInstanceOf(SetupError);
      await expect(readBookingService(fakeClient([{ data: null, error: null }]).client, TENANT)).rejects.toBeInstanceOf(SetupError);
      const other = { id: "30000000-0000-4000-8000-000000000009", agent_settings: {} };
      await expect(readBookingService(fakeClient([{ data: other, error: null }]).client, TENANT)).rejects.toBeInstanceOf(SetupError);
    });
  });

  describe("saving", () => {
    const written = (calls: [string, unknown[]][]) => calls.find(([name]) => name === "update")?.[1][0];

    it("sets the choice and keeps every other setting as it was read just before", async () => {
      const current = { persona: "Asha", tone: "formal", privacyNotice: true, handoffTriggers: [{ key: "hot_lead", enabled: false }] };
      const { client, calls } = fakeClient([
        { data: { id: TENANT, agent_settings: current }, error: null },
        { data: [{ id: TENANT, agent_settings: { ...current, bookingServiceId: B } }], error: null },
      ]);
      expect(await saveBookingService(client, TENANT, B)).toBe(B);
      expect(written(calls)).toEqual({ agent_settings: { ...current, bookingServiceId: B } });
      expect(calls.filter(([name, args]) => name === "eq" && args[0] === "id" && args[1] === TENANT).length).toBe(2);
    });

    it("clears the choice by removing the key, and leaves other settings alone", async () => {
      const { client, calls } = fakeClient([
        { data: { id: TENANT, agent_settings: { tone: "formal", bookingServiceId: A } }, error: null },
        { data: [{ id: TENANT, agent_settings: { tone: "formal" } }], error: null },
      ]);
      expect(await saveBookingService(client, TENANT, null)).toBeNull();
      expect(written(calls)).toEqual({ agent_settings: { tone: "formal" } });
    });

    it("starts from an empty object for a business that has no settings yet", async () => {
      const { client, calls } = fakeClient([
        { data: { id: TENANT, agent_settings: null }, error: null },
        { data: [{ id: TENANT, agent_settings: { bookingServiceId: A } }], error: null },
      ]);
      await saveBookingService(client, TENANT, A);
      expect(written(calls)).toEqual({ agent_settings: { bookingServiceId: A } });
    });

    it("never overwrites settings that are not a plain object, and writes nothing", async () => {
      for (const odd of ["tone: formal", ["formal"], 7]) {
        const { client, calls } = fakeClient([{ data: { id: TENANT, agent_settings: odd }, error: null }]);
        await expect(saveBookingService(client, TENANT, A)).rejects.toBeInstanceOf(SetupError);
        expect(written(calls)).toBeUndefined();
      }
    });

    it("refuses something that isn't a service id before reading or writing anything", async () => {
      const { client, calls } = fakeClient([{ data: null, error: null }]);
      await expect(saveBookingService(client, TENANT, "Site visit")).rejects.toBeInstanceOf(SetupError);
      expect(calls).toEqual([]);
    });

    it("says nothing was saved when the database changes no row, or answers with a different choice", async () => {
      const read = { data: { id: TENANT, agent_settings: {} }, error: null };
      await expect(saveBookingService(fakeClient([read, { data: [], error: null }]).client, TENANT, A)).rejects.toMatchObject({ reason: "not_found" });
      const differs = { data: [{ id: TENANT, agent_settings: { bookingServiceId: B } }], error: null };
      await expect(saveBookingService(fakeClient([read, differs]).client, TENANT, A)).rejects.toBeInstanceOf(SetupError);
    });

    it("passes a database error from the write on", async () => {
      const pgError = { code: "42501", message: "permission denied", details: null, hint: null };
      const read = { data: { id: TENANT, agent_settings: {} }, error: null };
      await expect(saveBookingService(fakeClient([read, { data: null, error: pgError }]).client, TENANT, A)).rejects.toBe(pgError);
    });
  });
});

describe("isSelectableChoice", () => {
  const services = [service(A, "Site visit"), service(B, "Video call", false)];
  it("always allows clearing the choice", () => {
    expect(isSelectableChoice(services, null)).toBe(true);
    expect(isSelectableChoice([], null)).toBe(true);
  });
  it("allows only an id that names an active service", () => {
    expect(isSelectableChoice(services, A)).toBe(true);
    expect(isSelectableChoice(services, B)).toBe(false);
    expect(isSelectableChoice(services, GONE)).toBe(false);
  });
  it("refuses a value that is not a UUID even if a service carries it", () => {
    expect(isSelectableChoice([service("Site visit", "Site visit")], "Site visit")).toBe(false);
  });
});

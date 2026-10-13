import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  createService,
  describeWriteError,
  deleteService,
  EMPTY_DRAFT,
  formatBookingRules,
  formatDuration,
  formatPriceRange,
  formatRupees,
  listResourceTypes,
  listServices,
  removeService,
  ServiceError,
  toDraft,
  updateService,
  upsertService,
  validateDraft,
  type Service,
  type ServiceDraft,
  type ServiceRow,
} from "./data";

const TENANT = "c0000000-0000-0000-0000-00000000000a";
const id = (n: number) => `e0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const row = (over: Partial<ServiceRow> = {}): ServiceRow => ({
  id: id(1),
  tenant_id: TENANT,
  name: "Haircut",
  duration_min: 30,
  price_min: 300,
  price_max: 600,
  resource_type: "stylist",
  active: true,
  buffer_min: 10,
  min_notice_min: 60,
  ...over,
});

const service = (over: Partial<Service> = {}): Service => ({
  id: id(1),
  name: "Haircut",
  durationMin: 30,
  priceMin: 300,
  priceMax: 600,
  resourceType: "stylist",
  active: true,
  bufferMin: 10,
  minNoticeMin: 60,
  ...over,
});

const draft = (over: Partial<ServiceDraft> = {}): ServiceDraft => ({
  ...EMPTY_DRAFT,
  name: "Bridal trial",
  durationMin: "90",
  resourceType: "stylist",
  ...over,
});

/** A chainable stand-in for the PostgREST query builder that records every call. */
function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "insert", "update", "delete", "eq", "order"]) {
    builder[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const client = {
    from: (table: string) => {
      calls.push(["from", [table]]);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("validating the form before anything is saved", () => {
  it("turns the form into column values", () => {
    const result = validateDraft(draft({ name: "  Bridal trial ", priceMin: "2,500", priceMax: "₹5000", active: false }), [], null);
    expect(result).toEqual({
      ok: true,
      input: {
        name: "Bridal trial",
        duration_min: 90,
        price_min: 2500,
        price_max: 5000,
        resource_type: "stylist",
        active: false,
        buffer_min: 0,
        min_notice_min: 60,
      },
    });
  });

  it("stores blank prices as no price", () => {
    const result = validateDraft(draft(), [], null);
    expect(result.ok && result.input).toMatchObject({ price_min: null, price_max: null });
  });

  it("requires a name, a length and who it's booked with", () => {
    const result = validateDraft(EMPTY_DRAFT, [], null);
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.fields).sort()).toEqual(["durationMin", "name", "resourceType"]);
  });

  it.each([
    ["0", "A booking takes at least 1 minute"],
    ["-5", "Enter whole minutes, like 30"],
    ["1.5", "Enter whole minutes, like 30"],
    ["thirty", "Enter whole minutes, like 30"],
    ["10081", "Keep the length to 7 days (10,080 minutes) or less"],
  ])("rejects a length of %s", (value, message) => {
    const result = validateDraft(draft({ durationMin: value }), [], null);
    expect(!result.ok && result.fields.durationMin).toBe(message);
  });

  it.each([
    ["-1", "Enter whole rupees, like 1500"],
    ["12.50", "Enter whole rupees, like 1500"],
    ["abc", "Enter whole rupees, like 1500"],
    ["99999999999", "That price is too large"],
  ])("rejects a price of %s", (value, message) => {
    const result = validateDraft(draft({ priceMin: value, priceMax: value }), [], null);
    expect(!result.ok && result.fields.priceMin).toBe(message);
    expect(!result.ok && result.fields.priceMax).toBe(message);
  });

  it("rejects a highest price below the lowest", () => {
    const result = validateDraft(draft({ priceMin: "600", priceMax: "300" }), [], null);
    expect(!result.ok && result.fields.priceMax).toBe("The highest price can't be below the lowest");
  });

  it("starts a new service with the database's defaults: no gap, an hour's notice", () => {
    expect(EMPTY_DRAFT).toMatchObject({ bufferMin: "0", minNoticeMin: "60" });
  });

  it("saves the gap between bookings and the minimum notice", () => {
    const result = validateDraft(draft({ bufferMin: " 15 ", minNoticeMin: "1440" }), [], null);
    expect(result.ok && result.input).toMatchObject({ buffer_min: 15, min_notice_min: 1440 });
  });

  it.each([
    ["", "Enter the gap in minutes, or 0 for none"],
    ["-5", "Enter whole minutes, like 15"],
    ["7.5", "Enter whole minutes, like 15"],
    ["241", "Keep the gap to 240 minutes (4 hours) or less"],
  ])("rejects a gap of %j, as the database would (0–240)", (value, message) => {
    const result = validateDraft(draft({ bufferMin: value }), [], null);
    expect(!result.ok && result.fields.bufferMin).toBe(message);
  });

  it.each([
    ["", "Enter the notice in minutes, or 0 for none"],
    ["soon", "Enter whole minutes, like 15"],
    ["10081", "Keep the notice to 7 days (10,080 minutes) or less"],
  ])("rejects a minimum notice of %j, as the database would (0–10,080)", (value, message) => {
    const result = validateDraft(draft({ minNoticeMin: value }), [], null);
    expect(!result.ok && result.fields.minNoticeMin).toBe(message);
  });

  it("accepts the limits themselves", () => {
    expect(validateDraft(draft({ bufferMin: "240", minNoticeMin: "10080" }), [], null).ok).toBe(true);
    expect(validateDraft(draft({ bufferMin: "0", minNoticeMin: "0" }), [], null).ok).toBe(true);
  });

  it("refuses a name another service already has, but not the service's own", () => {
    const existing = [service({ id: id(1), name: "Haircut" })];
    expect(!validateDraft(draft({ name: "haircut " }), existing, null).ok).toBe(true);
    expect(validateDraft(draft({ name: "Haircut" }), existing, id(1)).ok).toBe(true);
  });

  it("round-trips an existing service through the form", () => {
    const s = service({ priceMin: null, priceMax: 600 });
    const result = validateDraft(toDraft(s), [s], s.id);
    expect(result).toEqual({
      ok: true,
      input: { name: "Haircut", duration_min: 30, price_min: null, price_max: 600, resource_type: "stylist", active: true, buffer_min: 10, min_notice_min: 60 },
    });
  });
});

describe("display", () => {
  it("writes a service's booking rules", () => {
    expect(formatBookingRules({ bufferMin: 15, minNoticeMin: 120 })).toBe("15 min gap · 2 hours notice");
    expect(formatBookingRules({ bufferMin: 0, minNoticeMin: 0 })).toBe("No gap · No notice");
    expect(formatBookingRules({ bufferMin: 0, minNoticeMin: 1440 })).toBe("No gap · 1 day notice");
  });

  it("writes rupees like the prototype", () => {
    expect(formatRupees(1500)).toBe("₹1,500");
    expect(formatRupees(8_800_000)).toBe("₹88 L");
    expect(formatRupees(10_200_000)).toBe("₹1.02 Cr");
  });

  it("writes price ranges", () => {
    expect(formatPriceRange(300, 600)).toBe("₹300 – ₹600");
    expect(formatPriceRange(500, 500)).toBe("₹500");
    expect(formatPriceRange(300, null)).toBe("From ₹300");
    expect(formatPriceRange(null, 600)).toBe("Up to ₹600");
    expect(formatPriceRange(0, 0)).toBe("Free");
    expect(formatPriceRange(null, null)).toBe("—");
  });

  it("writes lengths", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("60 min");
    expect(formatDuration(90)).toBe("90 min");
    expect(formatDuration(120)).toBe("2 hours");
    expect(formatDuration(1440)).toBe("1 day");
  });

  it("keeps the list in name order as services are added, changed and removed", () => {
    let list = [service({ id: id(1), name: "Haircut" })];
    list = upsertService(list, service({ id: id(2), name: "Bridal trial" }));
    list = upsertService(list, service({ id: id(1), name: "Wash and cut" }));
    expect(list.map((s) => s.name)).toEqual(["Bridal trial", "Wash and cut"]);
    expect(removeService(list, id(2)).map((s) => s.id)).toEqual([id(1)]);
  });
});

describe("reads and writes", () => {
  it("lists the session's business's services only", async () => {
    const { client, calls } = fakeClient({ data: [row({ name: "Wash" }), row({ id: id(2), name: "Bridal trial" })], error: null });
    const list = await listServices(client, TENANT);
    expect(calls).toContainEqual(["from", ["services"]]);
    expect(calls).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(list.map((s) => s.name)).toEqual(["Bridal trial", "Wash"]);
  });

  it("creates for the session's business", async () => {
    const { client, calls } = fakeClient({ data: [row()], error: null });
    const input = { name: "Haircut", duration_min: 30, price_min: 300, price_max: 600, resource_type: "stylist", active: true, buffer_min: 10, min_notice_min: 60 };
    expect(await createService(client, TENANT, input)).toEqual(service());
    expect(calls).toContainEqual(["insert", [{ ...input, tenant_id: TENANT }]]);
  });

  it("updates only within the session's business, and never ignores an update that changed nothing", async () => {
    const input = { name: "Haircut", duration_min: 30, price_min: null, price_max: null, resource_type: "stylist", active: true, buffer_min: 0, min_notice_min: 60 };
    const ok = fakeClient({ data: [row({ price_min: null, price_max: null })], error: null });
    await updateService(ok.client, TENANT, id(1), input);
    expect(ok.calls).toContainEqual(["eq", ["id", id(1)]]);
    expect(ok.calls).toContainEqual(["eq", ["tenant_id", TENANT]]);
    // Row-level security hides other businesses' rows, so an update there matches nothing.
    await expect(updateService(fakeClient({ data: [], error: null }).client, TENANT, id(9), input)).rejects.toMatchObject({ reason: "not_found" });
  });

  it("reports a delete that removed nothing instead of pretending it worked", async () => {
    const ok = fakeClient({ data: [{ id: id(1) }], error: null });
    await expect(deleteService(ok.client, TENANT, id(1))).resolves.toBeUndefined();
    expect(ok.calls).toContainEqual(["eq", ["tenant_id", TENANT]]);
    await expect(deleteService(fakeClient({ data: [], error: null }).client, TENANT, id(9))).rejects.toMatchObject({ reason: "not_found" });
  });

  it("explains that a service with bookings can't be deleted", async () => {
    const fk = { code: "23503", message: "violates foreign key constraint", details: "", hint: null };
    const err = await deleteService(fakeClient({ data: null, error: fk }).client, TENANT, id(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ reason: "in_use" });
  });

  it("passes other database errors on and rejects rows of the wrong shape", async () => {
    const pg = { code: "42501", message: "new row violates row-level security policy", details: null, hint: null };
    await expect(listServices(fakeClient({ data: null, error: pg }).client, TENANT)).rejects.toBe(pg);
    await expect(listServices(fakeClient({ data: [{ id: "x" }], error: null }).client, TENANT)).rejects.toMatchObject({ reason: "invalid_response" });
  });

  it("offers the business's resource types as suggestions, and does without them on error", async () => {
    const { client, calls } = fakeClient({ data: [{ type: "stylist" }, { type: "chair" }, { type: "stylist" }], error: null });
    expect(await listResourceTypes(client, TENANT)).toEqual(["chair", "stylist"]);
    expect(calls).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(await listResourceTypes(fakeClient({ data: null, error: { code: "x" } }).client, TENANT)).toEqual([]);
  });
});

describe("errors after a failed save or delete", () => {
  it("shows the service's own message for a known failure", () => {
    const e = describeWriteError(new ServiceError("in_use", "This service has bookings."), "Couldn't delete the service");
    expect(e).toMatchObject({ code: "conflict", title: "Couldn't delete the service", message: "This service has bookings." });
  });

  it("never words a failed write as a failed load", () => {
    const pg = { code: "42501", message: "new row violates row-level security policy", details: null, hint: null };
    const e = describeWriteError(pg, "Couldn't save the service");
    expect(e.title).toBe("Couldn't save the service");
    // Since migration 0028 a row-level-security refusal on a write means the member's role may not change this: say so, don't suggest retrying.
    expect(e.code).toBe("forbidden");
    expect(e.retryable).toBe(false);
    expect(e.message).toBe("Only an owner or admin can change this. Nothing was changed.");
    expect(e.message).not.toMatch(/load|row-level/);
  });

  it("keeps the offline message", () => {
    expect(describeWriteError(new TypeError("Failed to fetch"), "Couldn't save the service").message).toMatch(/connection/);
  });
});

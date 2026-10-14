import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";
import { DeletionDataError, describeDeletionError, describeOutcome, fetchDeletionPreview, requestDeletion } from "@/lib/privacy/deletion";

const getJson = vi.fn();
const postJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ getJson: (...args: unknown[]) => getJson(...args), postJson: (...args: unknown[]) => postJson(...args) }));

const TENANT = "10000000-0000-0000-0000-000000000004";
const CONTACT = "20000000-0000-0000-0000-000000000001";
const preview = { contactId: CONTACT, deletedAt: null, conversations: 2, messages: 14, leads: 1, bookings: 1, upcomingBookings: 0 };
const result = (over: object = {}) => ({
  status: "deleted",
  removed: { conversations: 2, messages: 14, leads: 1, bookings: 1 },
  calendarEvents: { removed: 1, left: 0 },
  ...over,
});
const refusal = (status: number, code: string, message: string) => new ApiError(status, { error: { code, message } } as never);

beforeEach(() => {
  getJson.mockReset();
  postJson.mockReset();
});

describe("fetchDeletionPreview", () => {
  it("reads the preview for the business and contact, and sends nothing but the path", async () => {
    getJson.mockResolvedValue(preview);
    expect(await fetchDeletionPreview(TENANT, CONTACT)).toEqual(preview);
    expect(getJson).toHaveBeenCalledWith(`/api/contacts/${CONTACT}/deletion`, { tenantId: TENANT, signal: undefined });
  });

  it("refuses an id that is not a GUID before anything is sent", async () => {
    await expect(fetchDeletionPreview(TENANT, "../x?y=1")).rejects.toBeInstanceOf(DeletionDataError);
    expect(getJson).not.toHaveBeenCalled();
  });

  it("treats an answer of the wrong shape, or about another contact, as an error", async () => {
    getJson.mockResolvedValueOnce({ ...preview, messages: "many" });
    await expect(fetchDeletionPreview(TENANT, CONTACT)).rejects.toBeInstanceOf(DeletionDataError);
    getJson.mockResolvedValueOnce({ ...preview, contactId: "20000000-0000-0000-0000-000000000002" });
    await expect(fetchDeletionPreview(TENANT, CONTACT)).rejects.toBeInstanceOf(DeletionDataError);
  });
});

describe("requestDeletion", () => {
  it("posts with no body and returns the confirmed result", async () => {
    postJson.mockResolvedValue(result());
    expect((await requestDeletion(TENANT, CONTACT)).status).toBe("deleted");
    expect(postJson).toHaveBeenCalledWith(`/api/contacts/${CONTACT}/deletion`, undefined, { tenantId: TENANT });
  });

  it("is never a success unless the answer is deleted or already_deleted in the documented shape", async () => {
    for (const bad of [{}, null, "ok", result({ status: "queued" }), result({ calendarEvents: { removed: 0 } }), result({ removed: { conversations: -1, messages: 0, leads: 0, bookings: 0 } })]) {
      postJson.mockResolvedValueOnce(bad);
      await expect(requestDeletion(TENANT, CONTACT), JSON.stringify(bad)).rejects.toBeInstanceOf(DeletionDataError);
    }
  });

  it("is an error, never a success, when the answer cannot even be read (an empty or cut-off body)", async () => {
    const unreadable = new SyntaxError("Unexpected end of JSON input");
    postJson.mockRejectedValue(unreadable);
    await expect(requestDeletion(TENANT, CONTACT)).rejects.toBe(unreadable);
    expect(describeDeletionError(unreadable).kind).toBe("other");
  });

  it("lets a server refusal through unchanged", async () => {
    const conflict = refusal(409, "conflict", "This customer has a booking coming up.");
    postJson.mockRejectedValue(conflict);
    await expect(requestDeletion(TENANT, CONTACT)).rejects.toBe(conflict);
  });
});

describe("describeOutcome", () => {
  it("says what a deletion removed and shows the calendar counts, with no warning when none were left", () => {
    const o = describeOutcome(result() as never);
    expect(o.status).toBe("deleted");
    expect(o.headline).toMatch(/was deleted/);
    expect(o.removed).toBe("Removed 2 chats, 14 messages, 1 lead and 1 booking.");
    expect(o.calendar).toEqual({ removed: 1, left: 0 });
    expect(o.calendarWarning).toBeNull();
  });

  it("warns, with the server's count, when calendar events could not be taken down", () => {
    expect(describeOutcome(result({ calendarEvents: { removed: 2, left: 1 } }) as never).calendarWarning).toMatch(/^1 Google Calendar event could not be taken down/);
    expect(describeOutcome(result({ calendarEvents: { removed: 0, left: 3 } }) as never).calendarWarning).toMatch(/^3 Google Calendar events could not be taken down/);
  });

  it("says already_deleted changed nothing and does not claim anything was removed", () => {
    const o = describeOutcome(result({ status: "already_deleted", removed: { conversations: 0, messages: 0, leads: 0, bookings: 0 } }) as never);
    expect(o.status).toBe("already_deleted");
    expect(o.headline).toMatch(/already been deleted/);
    expect(o.removed).toBeNull();
  });
});

describe("describeDeletionError", () => {
  it("names the upcoming-booking conflict and keeps the server's own explanation", () => {
    const e = describeDeletionError(refusal(409, "conflict", "This customer has a booking coming up. Cancel it first."));
    expect(e).toMatchObject({ kind: "conflict", title: "This customer has a booking coming up", message: "This customer has a booking coming up. Cancel it first.", retryable: false });
  });

  it("names a refusal for staff and an unknown contact, with nothing to retry", () => {
    expect(describeDeletionError(refusal(403, "forbidden", "Only an owner or admin can delete a customer's data."))).toMatchObject({ kind: "forbidden", retryable: false });
    expect(describeDeletionError(refusal(404, "not_found", "That contact was not found."))).toMatchObject({ kind: "not_found", retryable: false });
  });

  it("never turns a malformed answer into a success, and says it cannot confirm", () => {
    const e = describeDeletionError(new DeletionDataError("deletion"));
    expect(e.kind).toBe("malformed");
    expect(e.message).toMatch(/can't say whether the data was deleted/);
  });

  it("offers a retry for a server fault and for being offline", () => {
    expect(describeDeletionError(refusal(500, "internal", "boom")).retryable).toBe(true);
    expect(describeDeletionError(new TypeError("Failed to fetch")).retryable).toBe(true);
  });
});

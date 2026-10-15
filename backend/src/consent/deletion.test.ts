import type { TenantContext } from "@pakka/types";
import { describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import { contactDeletionPreview, deleteContactData, type DeletionDeps } from "./deletion";

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const USER = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
const CONTACT = "0f100000-0000-4000-8000-0000000000a1";
const RESOURCE = "0f500000-0000-4000-8000-00000000000a";

const context = (role: TenantContext["role"] = "owner"): TenantContext => ({
  user: { id: USER, email: "owner@skyline.test" },
  role,
  tenant: { id: TENANT, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "starter", trialEndsAt: null },
});

function deps(
  tables: Record<string, FakeDbResponse>,
  removeEvent: DeletionDeps["removeEvent"] = vi.fn(async () => "removed" as const),
  removeMedia: DeletionDeps["removeMedia"] = vi.fn(async () => ({ removed: 0, left: 0 })),
) {
  const db = fakeDb(tables);
  return { d: { db: db.client, removeEvent, removeMedia } satisfies DeletionDeps, calls: db.calls, removeEvent, removeMedia };
}
const rpcArgs = (calls: ReturnType<typeof deps>["calls"], name: string) => calls.find((c) => c.table === `rpc:${name}`)?.args[0];

const CHAT = "0f830000-0000-4000-8000-000000000001";
const deleted = (events: { resource_id: string; event_id: string }[] = [], outcome = "deleted", conversationIds: string[] = [CHAT]): FakeDbResponse => ({
  data: [{ outcome, conversations: conversationIds.length, messages: 12, leads: 1, bookings: 2, calendar_events: events, conversation_ids: conversationIds }],
  error: null,
});

describe("GET /api/contacts/:id/deletion", () => {
  it("says what a deletion would remove, for this business only", async () => {
    const { d, calls } = deps({ "rpc:contact_deletion_preview": { data: [{ deleted_at: null, conversations: 1, messages: 12, leads: 1, bookings: 2, upcoming_bookings: 0 }], error: null } });
    expect(await contactDeletionPreview(context("admin"), CONTACT, d)).toEqual({ contactId: CONTACT, deletedAt: null, conversations: 1, messages: 12, leads: 1, bookings: 2, upcomingBookings: 0 });
    expect(rpcArgs(calls, "contact_deletion_preview")).toEqual({ p_tenant_id: TENANT, p_contact_id: CONTACT });
  });

  it("does not know another business's contact, or an id that isn't one", async () => {
    await expect(contactDeletionPreview(context(), CONTACT, deps({ "rpc:contact_deletion_preview": { data: [], error: null } }).d)).rejects.toMatchObject({ code: "not_found" });
    const { d, calls } = deps({});
    await expect(contactDeletionPreview(context(), "not-an-id", d)).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/contacts/:id/deletion", () => {
  it("deletes the data, naming the member, and takes the past bookings' events off Google Calendar", async () => {
    const event = { resource_id: RESOURCE, event_id: "pkevent1" };
    const { d, calls, removeEvent } = deps({ "rpc:delete_contact_data": deleted([event]) });
    expect(await deleteContactData(context(), CONTACT, d)).toEqual({
      status: "deleted",
      removed: { conversations: 1, messages: 12, leads: 1, bookings: 2 },
      calendarEvents: { removed: 1, left: 0 },
      mediaFiles: { removed: 0, left: 0 },
    });
    expect(rpcArgs(calls, "delete_contact_data")).toEqual({ p_tenant_id: TENANT, p_contact_id: CONTACT, p_actor: USER });
    expect(removeEvent).toHaveBeenCalledWith(TENANT, { resourceId: RESOURCE, eventId: "pkevent1" });
  });

  // 0048: delete_contact_data names the chats it deleted, and their photos, voice notes and documents are removed from storage.
  it("removes the deleted chats' media files, and counts any it could not as left, never failing the deletion", async () => {
    const removeMedia = vi.fn<DeletionDeps["removeMedia"]>(async () => ({ removed: 3, left: 0 }));
    const one = deps({ "rpc:delete_contact_data": deleted() }, undefined, removeMedia);
    expect((await deleteContactData(context(), CONTACT, one.d)).mediaFiles).toEqual({ removed: 3, left: 0 });
    expect(removeMedia).toHaveBeenCalledWith(TENANT, [CHAT]);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const partly = deps({ "rpc:delete_contact_data": deleted() }, undefined, vi.fn(async () => ({ removed: 1, left: 2 })));
    expect((await deleteContactData(context(), CONTACT, partly.d)).mediaFiles).toEqual({ removed: 1, left: 2 });
    const unlisted = deps({ "rpc:delete_contact_data": deleted() }, undefined, vi.fn(async () => Promise.reject(new Error("message media: listing the files failed"))));
    expect(await deleteContactData(context(), CONTACT, unlisted.d)).toMatchObject({ status: "deleted", mediaFiles: { removed: 0, left: 0 } });
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("asks storage for nothing when no chat was deleted (asked again, or a contact who never wrote)", async () => {
    const { d, removeMedia } = deps({ "rpc:delete_contact_data": deleted([], "already_deleted", []) });
    await deleteContactData(context(), CONTACT, d);
    expect(removeMedia).toHaveBeenCalledWith(TENANT, []);
  });

  it("counts an event it could not take down as left, and never fails the deletion for it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = [
      { resource_id: RESOURCE, event_id: "pk1" },
      { resource_id: RESOURCE, event_id: "pk2" },
      { resource_id: RESOURCE, event_id: "pk3" },
    ];
    const removeEvent = vi
      .fn<DeletionDeps["removeEvent"]>()
      .mockResolvedValueOnce("already_gone")
      .mockRejectedValueOnce(new Error("google sync: removing the event failed (503)"))
      .mockResolvedValueOnce("no_calendar");
    const out = await deleteContactData(context(), CONTACT, deps({ "rpc:delete_contact_data": deleted(events) }, removeEvent).d);
    expect(out.calendarEvents).toEqual({ removed: 1, left: 2 });
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("says when it had been done already", async () => {
    const out = await deleteContactData(context(), CONTACT, deps({ "rpc:delete_contact_data": deleted([], "already_deleted") }).d);
    expect(out.status).toBe("already_deleted");
  });

  it("is for an owner or admin, refuses while a booking is coming up, and does not know another business's contact", async () => {
    const { d, calls } = deps({ "rpc:delete_contact_data": deleted() });
    await expect(deleteContactData(context("staff"), CONTACT, d)).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toHaveLength(0);
    const upcoming = deps({ "rpc:delete_contact_data": { data: null, error: { code: "PA409", message: "upcoming booking" } } });
    await expect(deleteContactData(context(), CONTACT, upcoming.d)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Cancel it first") });
    const other = deps({ "rpc:delete_contact_data": { data: null, error: { code: "PA404", message: "no such contact" } } });
    await expect(deleteContactData(context(), CONTACT, other.d)).rejects.toMatchObject({ code: "not_found" });
  });
});

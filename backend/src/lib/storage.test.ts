import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { MESSAGE_MEDIA_BUCKET, mediaExtension, messageMediaNames, messageMediaPath, removeMessageMedia } from "./storage";

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const CONV = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const MESSAGE = "8e9f0a1b-2c3d-4e5f-8a7b-9c0d1e2f3a4b";

describe("message media (0047)", () => {
  it("is the private bucket message-media, at <tenant_id>/<conversation_id>/<message_id>.<ext>", () => {
    expect(MESSAGE_MEDIA_BUCKET).toBe("message-media");
    expect(messageMediaPath(TENANT, CONV, MESSAGE, "jpg")).toBe(`${TENANT}/${CONV}/${MESSAGE}.jpg`);
    expect(messageMediaPath(TENANT.toUpperCase(), CONV, MESSAGE, "pdf")).toBe(`${TENANT}/${CONV}/${MESSAGE}.pdf`);
  });

  it("refuses anything that could step outside the business's folder", () => {
    expect(() => messageMediaPath("../other", CONV, MESSAGE, "jpg")).toThrow("business id");
    expect(() => messageMediaPath(TENANT, "x/../../y", MESSAGE, "jpg")).toThrow("conversation id");
    expect(() => messageMediaPath(TENANT, CONV, `${MESSAGE}/..`, "jpg")).toThrow("message id");
    expect(() => messageMediaPath(TENANT, CONV, MESSAGE, "jpg/../x")).toThrow("extension");
    expect(() => messageMediaPath(TENANT, CONV, MESSAGE, "")).toThrow("extension");
  });

  it("names the extension from WhatsApp's media type, codecs and case aside", () => {
    expect(mediaExtension("image/jpeg")).toBe("jpg");
    expect(mediaExtension("audio/ogg; codecs=opus")).toBe("ogg");
    expect(mediaExtension("Application/PDF")).toBe("pdf");
    expect(mediaExtension("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(mediaExtension("application/x-something")).toBe("bin");
    expect(mediaExtension(null)).toBe("bin");
  });
});

describe("removing a business's or some chats' files (0048)", () => {
  const fake = (names: unknown, fail: (batch: string[]) => boolean = () => false) => {
    const rpc = vi.fn(async () => ({ data: names, error: null }));
    const remove = vi.fn(async (batch: string[]) => ({ data: null, error: fail(batch) ? { message: "storage down" } : null }));
    const from = vi.fn(() => ({ remove }));
    return { db: { rpc, storage: { from } } as unknown as SupabaseClient, rpc, remove, from };
  };
  const FILE = `${TENANT}/${CONV}/${MESSAGE}.jpg`;

  it("lists the files by their path, for a business or some of its chats, and asks nothing for no chats", async () => {
    const f = fake([FILE]);
    expect(await messageMediaNames(f.db, TENANT, [CONV])).toEqual([FILE]);
    expect(f.rpc).toHaveBeenCalledWith("media_object_names", { p_tenant_id: TENANT, p_conversation_ids: [CONV] });
    await messageMediaNames(f.db, TENANT);
    expect(f.rpc).toHaveBeenLastCalledWith("media_object_names", { p_tenant_id: TENANT, p_conversation_ids: null });
    f.rpc.mockClear();
    expect(await messageMediaNames(f.db, TENANT, [])).toEqual([]);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("fails in fixed words when the files cannot be listed", async () => {
    const db = { rpc: async () => ({ data: null, error: { message: "connection to 10.0.0.5 refused" } }) } as unknown as SupabaseClient;
    await expect(messageMediaNames(db, TENANT)).rejects.toThrow(/^message media: listing the files failed$/);
  });

  it("removes through the Storage API in batches of 100, counting a batch that fails as left, never throwing", async () => {
    const paths = Array.from({ length: 250 }, (_, i) => `${TENANT}/${CONV}/m${i}.jpg`);
    const ok = fake([]);
    expect(await removeMessageMedia(ok.db, paths)).toEqual({ removed: 250, left: 0 });
    expect(ok.from).toHaveBeenCalledWith(MESSAGE_MEDIA_BUCKET);
    expect(ok.remove.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 50]);

    const second = fake([], (batch) => batch[0] === paths[100]);
    expect(await removeMessageMedia(second.db, paths)).toEqual({ removed: 150, left: 100 });
    expect(await removeMessageMedia(ok.db, [])).toEqual({ removed: 0, left: 0 });
  });
});

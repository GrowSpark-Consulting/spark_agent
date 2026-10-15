import { describe, expect, it, vi } from "vitest";
import { createSignedUrlCache, REUSE_MARGIN_MS, SIGNED_URL_SECONDS, storageSigner, storedMediaPath } from "./media-url";

const TENANT = "10000000-0000-0000-0000-000000000004";
const OTHER_TENANT = "10000000-0000-0000-0000-0000000000ff";
const CHAT = "40000000-0000-0000-0000-000000000002";
const MESSAGE = "41000000-0000-0000-0000-000000000009";
const GOOD = `${TENANT}/${CHAT}/${MESSAGE}.jpg`;

describe("storedMediaPath", () => {
  it("accepts the job's path for this business and chat", () => {
    expect(storedMediaPath(GOOD, TENANT, CHAT)).toBe(GOOD);
    expect(storedMediaPath(`${TENANT}/${CHAT}/${MESSAGE}.pdf`, TENANT, CHAT)).not.toBeNull();
  });

  it("refuses anything that is not a string path", () => {
    for (const value of [undefined, null, 5, {}, ["a"], ""]) expect(storedMediaPath(value, TENANT, CHAT)).toBeNull();
  });

  it("refuses another business's file, another chat's file, and a path with no business first", () => {
    expect(storedMediaPath(`${OTHER_TENANT}/${CHAT}/${MESSAGE}.jpg`, TENANT, CHAT)).toBeNull();
    expect(storedMediaPath(`${TENANT}/40000000-0000-0000-0000-000000000003/${MESSAGE}.jpg`, TENANT, CHAT)).toBeNull();
    expect(storedMediaPath(`${CHAT}/${MESSAGE}.jpg`, TENANT, CHAT)).toBeNull();
  });

  it("refuses traversal, absolute and URL-shaped paths, extra folders and odd extensions", () => {
    for (const bad of [
      `../${TENANT}/${CHAT}/${MESSAGE}.jpg`,
      `${TENANT}/${CHAT}/../${MESSAGE}.jpg`,
      `/${GOOD}`,
      `${GOOD}/`,
      `${TENANT}/${CHAT}/extra/${MESSAGE}.jpg`,
      `https://evil.example/${GOOD}`,
      `${TENANT}/${CHAT}/${MESSAGE}.`,
      `${TENANT}/${CHAT}/${MESSAGE}.jpg?x=1`,
      `${TENANT}/${CHAT}/${MESSAGE}.toolongext`,
      `${TENANT}/${CHAT}/not-a-message-id.jpg`,
    ]) {
      expect(storedMediaPath(bad, TENANT, CHAT), bad).toBeNull();
    }
  });

  it("refuses when the business or chat given is not an id at all", () => {
    expect(storedMediaPath(GOOD, ".*", CHAT)).toBeNull();
    expect(storedMediaPath(GOOD, TENANT, ".*")).toBeNull();
  });
});

describe("storageSigner", () => {
  it("asks the message-media bucket for an hour-long link as the member", async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: "https://x.supabase.co/signed?token=t" }, error: null });
    const from = vi.fn().mockReturnValue({ createSignedUrl });
    const sign = storageSigner({ storage: { from } } as never);
    await expect(sign(GOOD)).resolves.toBe("https://x.supabase.co/signed?token=t");
    expect(from).toHaveBeenCalledWith("message-media");
    expect(createSignedUrl).toHaveBeenCalledWith(GOOD, SIGNED_URL_SECONDS);
    expect(SIGNED_URL_SECONDS).toBe(3600);
  });

  it("throws without the link in the message when storage refuses or gives none", async () => {
    const refuse = storageSigner({ storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "Object not found" } }) }) } } as never);
    await expect(refuse(GOOD)).rejects.toThrow("message media: could not sign the file");
    const empty = storageSigner({ storage: { from: () => ({ createSignedUrl: async () => ({ data: {}, error: null }) }) } } as never);
    await expect(empty(GOOD)).rejects.toThrow("could not sign");
  });
});

describe("createSignedUrlCache", () => {
  it("makes one link for any number of asks at once", async () => {
    const sign = vi.fn().mockResolvedValue("u1");
    const cache = createSignedUrlCache(sign);
    await expect(Promise.all([cache.get(GOOD), cache.get(GOOD), cache.get(GOOD)])).resolves.toEqual(["u1", "u1", "u1"]);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("reuses a link until it has less than five minutes left, then makes a new one", async () => {
    let now = 1_000_000;
    const sign = vi.fn().mockResolvedValueOnce("u1").mockResolvedValueOnce("u2");
    const cache = createSignedUrlCache(sign, () => now);
    expect(await cache.get(GOOD)).toBe("u1");
    now += SIGNED_URL_SECONDS * 1000 - REUSE_MARGIN_MS - 1;
    expect(await cache.get(GOOD)).toBe("u1");
    now += 2;
    expect(await cache.get(GOOD)).toBe("u2");
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it("keeps a separate link for each path", async () => {
    const sign = vi.fn(async (path: string) => `url:${path}`);
    const cache = createSignedUrlCache(sign);
    const other = `${TENANT}/${CHAT}/41000000-0000-0000-0000-00000000000a.png`;
    expect(await cache.get(GOOD)).toBe(`url:${GOOD}`);
    expect(await cache.get(other)).toBe(`url:${other}`);
  });

  it("does not remember a failure: the next ask tries again", async () => {
    const sign = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce("u1");
    const cache = createSignedUrlCache(sign);
    await expect(cache.get(GOOD)).rejects.toThrow("down");
    await expect(cache.get(GOOD)).resolves.toBe("u1");
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it("forget makes the next ask sign again (a link that stopped working)", async () => {
    const sign = vi.fn().mockResolvedValueOnce("u1").mockResolvedValueOnce("u2");
    const cache = createSignedUrlCache(sign);
    await cache.get(GOOD);
    cache.forget(GOOD);
    expect(await cache.get(GOOD)).toBe("u2");
  });
});

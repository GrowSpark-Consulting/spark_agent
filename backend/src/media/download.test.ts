import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { connectionSecretContext, encryptSecret } from "../lib/crypto";
import { DOCUMENT_MAX_BYTES, downloadMessageMedia, IMAGE_MAX_BYTES, MediaRetryError, type DownloadDeps, type MediaMessage } from "./download";

// Saving a customer's photo or document (Day 7, PR F). Meta's Graph answers are UNVERIFIED (they follow Meta's documentation: GET /{media-id} gives a short-lived
// url, the url is fetched with the same token), so every call here goes to a fake. All values (tokens, ids, files) are made up in this file.

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const OTHER_TENANT = "7a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8e";
const CONV = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const MESSAGE = "8e9f0a1b-2c3d-4e5f-8a7b-9c0d1e2f3a4b";
const CHANNEL = "c1000000-0000-4000-8000-0000000000c1";
const CONNECTION = "d4000000-0000-4000-8000-0000000000a1";
const TOKEN = "EAABsyntheticMediaTokenForTheTests0001112223334";
const KEY = randomBytes(32).toString("base64");
const env = { ENCRYPTION_KEY: KEY, META_GRAPH_API_VERSION: "v26.0" };
const IDS = { tenantId: TENANT, conversationId: CONV, messageId: MESSAGE };
const FILE_URL = "https://lookaside.example.test/file?token=SYNTHETICURLTOKEN";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const PDF = new TextEncoder().encode("%PDF-1.7 synthetic");
const TEXT = new TextEncoder().encode("hello, a plain text file");
const ZIPPED = Uint8Array.from([0x50, 0x4b, 3, 4, 1, 2]);

const tokenEnc = () => encryptSecret(TOKEN, connectionSecretContext({ column: "token_enc", tenantId: TENANT, connectionId: CONNECTION }), env);

const message = (over: Partial<MediaMessage> = {}): MediaMessage => ({ kind: "image", channelId: CHANNEL, media: { id: "media-1", mime: "image/jpeg" }, ...over });
const meta = (over: Record<string, unknown> = {}) => Response.json({ url: FILE_URL, mime_type: "image/jpeg", file_size: 8, id: "media-1", ...over });
const file = (bytes: Uint8Array, headers: Record<string, string> = {}) => new Response(bytes as unknown as ArrayBuffer, { status: 200, headers });

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
function setup(over: { message?: MediaMessage | null; fetch?: Fetch; connection?: DownloadDeps["loadConnection"]; upload?: DownloadDeps["upload"]; save?: DownloadDeps["saveMedia"] } = {}) {
  const fetchFn = vi.fn<Fetch>(over.fetch ?? (async (url) => (url.startsWith("https://graph.facebook.com") ? meta() : file(JPEG))));
  const upload = vi.fn<DownloadDeps["upload"]>(over.upload ?? (async () => undefined));
  const saveMedia = vi.fn<DownloadDeps["saveMedia"]>(over.save ?? (async () => undefined));
  const loadMessage = vi.fn<DownloadDeps["loadMessage"]>(async () => (over.message === undefined ? message() : over.message));
  const loadConnection = vi.fn<DownloadDeps["loadConnection"]>(over.connection ?? (async () => ({ connectionId: CONNECTION, tokenEnc: tokenEnc() })));
  const deps: DownloadDeps = { loadMessage, loadConnection, saveMedia, upload, fetch: fetchFn as unknown as typeof fetch, env, timeoutMs: 200 };
  return { deps, fetchFn, upload, saveMedia, loadMessage, loadConnection };
}
const run = (s: ReturnType<typeof setup>) => downloadMessageMedia(IDS, s.deps);
const PATH = (ext: string) => `${TENANT}/${CONV}/${MESSAGE}.${ext}`;

describe("saving a photo", () => {
  it("asks Meta for the media's address, fetches it with the token, uploads under the message's path and records it on the message", async () => {
    const s = setup();
    expect(await run(s)).toEqual({ status: "stored" });
    expect(s.fetchFn).toHaveBeenCalledTimes(2);
    const [first, second] = s.fetchFn.mock.calls;
    expect(first[0]).toBe("https://graph.facebook.com/v26.0/media-1");
    expect(second[0]).toBe(FILE_URL);
    for (const call of [first, second]) expect((call[1]?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(s.upload).toHaveBeenCalledWith(PATH("jpg"), JPEG, "image/jpeg");
    expect(s.saveMedia).toHaveBeenCalledTimes(1);
    const [tenantId, messageId, media] = s.saveMedia.mock.calls[0];
    expect([tenantId, messageId]).toEqual([TENANT, MESSAGE]);
    expect(media).toMatchObject({ id: "media-1", mime: "image/jpeg", path: PATH("jpg"), size: JPEG.length });
    expect(typeof media.storedAt).toBe("string");
  });

  it("keeps what the message already had in media (id and mime) and adds to it", async () => {
    const s = setup({ message: message({ media: { id: "media-1", mime: "image/jpeg", filename: "kitchen.jpg" } }) });
    await run(s);
    expect(s.saveMedia.mock.calls[0][2]).toMatchObject({ id: "media-1", mime: "image/jpeg", filename: "kitchen.jpg", path: PATH("jpg") });
  });

  it.each([
    ["image", "image/png", PNG, "png"],
    ["image", "image/webp", WEBP, "webp"],
    ["document", "application/pdf", PDF, "pdf"],
    ["document", "text/plain", TEXT, "txt"],
  ] as const)("saves a %s of type %s as .%s", async (kind, mime, bytes, ext) => {
    const s = setup({ message: message({ kind, media: { id: "media-1", mime } }), fetch: async (url) => (url.startsWith("https://graph.facebook.com") ? meta({ mime_type: mime, file_size: bytes.length }) : file(bytes)) });
    expect(await run(s)).toEqual({ status: "stored" });
    expect(s.upload).toHaveBeenCalledWith(PATH(ext), bytes, mime);
  });

  it("saves the Office documents WhatsApp allows, whose files are zip or old Office containers (no magic-byte rule for them)", async () => {
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const s = setup({ message: message({ kind: "document", media: { id: "media-1", mime: docx } }), fetch: async (url) => (url.startsWith("https://graph.facebook.com") ? meta({ mime_type: docx, file_size: 6 }) : file(ZIPPED)) });
    expect(await run(s)).toEqual({ status: "stored" });
    expect(s.upload).toHaveBeenCalledWith(PATH("docx"), ZIPPED, docx);
  });

  it("trusts the type Meta gives for the file, not the one in the webhook, and ignores its codec parameters and case", async () => {
    const s = setup({ message: message({ media: { id: "media-1", mime: "application/x-msdownload" } }), fetch: async (url) => (url.startsWith("https://graph.facebook.com") ? meta({ mime_type: "Image/JPEG; q=1" }) : file(JPEG)) });
    expect(await run(s)).toEqual({ status: "stored" });
    expect(s.upload).toHaveBeenCalledWith(PATH("jpg"), JPEG, "image/jpeg");
  });
});

describe("what is not saved: type and size", () => {
  const marked = async (s: ReturnType<typeof setup>, reason: string, status: "skipped" | "unavailable" = "skipped") => {
    expect(await run(s)).toEqual({ status, reason });
    expect(s.upload).not.toHaveBeenCalled();
    expect(s.saveMedia).toHaveBeenCalledTimes(1);
    expect(s.saveMedia.mock.calls[0][2]).toMatchObject({ id: "media-1", [status]: reason });
    expect(s.saveMedia.mock.calls[0][2]).not.toHaveProperty("path");
  };
  const graph = (over: Record<string, unknown>, bytes: Uint8Array = JPEG): Fetch => async (url) => (url.startsWith("https://graph.facebook.com") ? meta(over) : file(bytes));

  it.each(["image/svg+xml", "text/html", "application/zip", "application/x-msdownload", "audio/ogg", "video/mp4", "image/gif", "application/octet-stream", ""])(
    "a file Meta calls %j is not saved, and nothing is downloaded",
    async (mime_type) => {
      const s = setup({ fetch: graph({ mime_type }) });
      await marked(s, "type_not_allowed");
      expect(s.fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it("a type that does not fit the kind (a pdf sent as an image, a jpeg sent as a document) is not saved", async () => {
    await marked(setup({ message: message({ kind: "image" }), fetch: graph({ mime_type: "application/pdf" }, PDF) }), "type_not_allowed");
    await marked(setup({ message: message({ kind: "document", media: { id: "media-1", mime: "application/pdf" } }), fetch: graph({ mime_type: "image/jpeg" }) }), "type_not_allowed");
  });

  it("a file whose first bytes are not what its type says is not saved (a program renamed .jpg, a pdf that is a zip)", async () => {
    await marked(setup({ fetch: graph({ mime_type: "image/jpeg", file_size: 6 }, ZIPPED) }), "type_not_allowed");
    await marked(setup({ message: message({ kind: "document", media: { id: "media-1", mime: "application/pdf" } }), fetch: graph({ mime_type: "application/pdf", file_size: 6 }, ZIPPED) }), "type_not_allowed");
    await marked(setup({ fetch: graph({ mime_type: "image/png", file_size: 8 }, JPEG) }), "type_not_allowed");
  });

  it("says no_answer-free numbers: an image over 5 MB by Meta's own size is refused before the download", async () => {
    const s = setup({ fetch: graph({ file_size: IMAGE_MAX_BYTES + 1 }) });
    await marked(s, "too_big");
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a size sent as text is read, and a size that is not a number is treated as unknown (the bytes are still counted)", async () => {
    await marked(setup({ fetch: graph({ file_size: String(IMAGE_MAX_BYTES + 1) }) }), "too_big");
    const s = setup({ fetch: graph({ file_size: "lots" }) });
    expect(await run(s)).toEqual({ status: "stored" });
  });

  it("an image of exactly 5 MB is saved; a document of exactly 20 MB is saved and one byte more is not", async () => {
    const big = (n: number, head: Uint8Array) => {
      const bytes = new Uint8Array(n);
      bytes.set(head);
      return bytes;
    };
    const image = big(IMAGE_MAX_BYTES, JPEG);
    expect(await run(setup({ fetch: graph({ file_size: image.length }, image) }))).toEqual({ status: "stored" });
    const doc = (n: number) => setup({ message: message({ kind: "document", media: { id: "media-1", mime: "application/pdf" } }), fetch: graph({ mime_type: "application/pdf", file_size: n }, big(n, PDF)) });
    expect(await run(doc(DOCUMENT_MAX_BYTES))).toEqual({ status: "stored" });
    await marked(doc(DOCUMENT_MAX_BYTES + 1), "too_big");
  });

  it("counts the bytes it reads: a file that says it is small but is not stops at the cap and is never uploaded", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(JPEG);
    const body = new ReadableStream<Uint8Array>({
      pull: (c) => c.enqueue(chunk),
      cancel: () => {
        cancelled = true;
      },
    });
    const s = setup({ fetch: async (url) => (url.startsWith("https://graph.facebook.com") ? meta({ file_size: 100 }) : new Response(body)) });
    await marked(s, "too_big");
    expect(cancelled).toBe(true);
  });

  it("a Content-Length over the cap is refused before reading the body", async () => {
    const s = setup({ fetch: async (url) => (url.startsWith("https://graph.facebook.com") ? meta({ file_size: 8 }) : file(JPEG, { "content-length": String(IMAGE_MAX_BYTES + 1) })) });
    await marked(s, "too_big");
  });

  it("an empty file is not saved", async () => {
    await marked(setup({ fetch: graph({ file_size: 0 }, new Uint8Array(0)) }), "type_not_allowed");
  });
});

describe("what Meta can answer", () => {
  it.each([404, 410, 400])("media that is gone (HTTP %i on the address lookup) is marked unavailable and not retried", async (status) => {
    const s = setup({ fetch: async () => Response.json({ error: { message: "SYNTHETIC-META-TEXT" } }, { status }) });
    expect(await run(s)).toEqual({ status: "unavailable", reason: "media_gone" });
    expect(s.saveMedia.mock.calls[0][2]).toMatchObject({ id: "media-1", unavailable: "media_gone" });
    expect(s.upload).not.toHaveBeenCalled();
  });

  it("the file's own address answering 404 (it expires in minutes) is the same", async () => {
    const s = setup({ fetch: async (url) => (url.startsWith("https://graph.facebook.com") ? meta() : new Response("gone", { status: 404 })) });
    expect(await run(s)).toEqual({ status: "unavailable", reason: "media_gone" });
  });

  it.each([401, 403])("a token Meta refuses (HTTP %i) is skipped without a mark and not retried: the file may be saved after a reconnect", async (status) => {
    const s = setup({ fetch: async () => new Response("no", { status }) });
    expect(await run(s)).toEqual({ status: "skipped", reason: "token_rejected" });
    expect(s.saveMedia).not.toHaveBeenCalled();
  });

  it.each([429, 500, 502, 503])("HTTP %i is thrown, so Inngest retries, and nothing is marked", async (status) => {
    const s = setup({ fetch: async () => new Response("later", { status }) });
    await expect(run(s)).rejects.toBeInstanceOf(MediaRetryError);
    expect(s.saveMedia).not.toHaveBeenCalled();
    expect(s.upload).not.toHaveBeenCalled();
  });

  it("any other refusal (a 418, say) is marked unavailable as rejected", async () => {
    const s = setup({ fetch: async () => new Response("?", { status: 418 }) });
    expect(await run(s)).toEqual({ status: "unavailable", reason: "rejected" });
  });

  it("a timeout, even from a fetch that ignores its abort signal, is thrown to be retried", async () => {
    const s = setup({ fetch: () => new Promise<Response>(() => undefined) });
    await expect(run(s)).rejects.toBeInstanceOf(MediaRetryError);
  });

  it("a network failure is thrown to be retried, with a fixed text that holds none of the error's words", async () => {
    const s = setup({ fetch: async () => Promise.reject(new Error(`connect ECONNREFUSED ${FILE_URL} Bearer ${TOKEN}`)) });
    const error = await run(s).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(MediaRetryError);
    expect(`${error?.name} ${error?.message}`).not.toMatch(/ECONNREFUSED|SYNTHETIC|EAAB|lookaside/);
  });

  it("a body that stalls half way is a timeout too", async () => {
    const body = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(JPEG) });
    const s = setup({ fetch: async (url) => (url.startsWith("https://graph.facebook.com") ? meta() : new Response(body)) });
    await expect(run(s)).rejects.toBeInstanceOf(MediaRetryError);
    expect(s.upload).not.toHaveBeenCalled();
  });

  it("an answer that is not what Meta documents (not JSON, no url, a missing type) is marked unavailable, not guessed at", async () => {
    for (const answer of [new Response("<html>", { status: 200 }), Response.json({}), Response.json({ url: FILE_URL }), Response.json({ url: 5, mime_type: "image/jpeg" })]) {
      const s = setup({ fetch: async () => answer.clone() });
      expect(await run(s)).toEqual({ status: "unavailable", reason: "bad_answer" });
      expect(s.saveMedia.mock.calls[0][2]).toMatchObject({ unavailable: "bad_answer" });
    }
  });

  it.each(["http://lookaside.example.test/x", "ftp://lookaside.example.test/x", "https://user:pw@lookaside.example.test/x", "https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x", "https://169.254.169.254/latest", "https://10.0.0.5/x", "javascript:alert(1)", "not a url"])(
    "an address that is not a plain public https one (%s) is never fetched, so the token cannot be sent there",
    async (url) => {
      const s = setup({ fetch: async () => meta({ url }) });
      expect(await run(s)).toEqual({ status: "unavailable", reason: "bad_answer" });
      expect(s.fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it("the media id from the webhook cannot change the address (a path or a query in it is refused)", async () => {
    for (const id of ["../me", "a/b", "1?access_token=x", "a b", ""]) {
      const s = setup({ message: message({ media: { id, mime: "image/jpeg" } }) });
      expect((await run(s)).status).toBe("skipped");
      expect(s.fetchFn).not.toHaveBeenCalled();
    }
  });
});

describe("what makes it do nothing", () => {
  it("a message that is not found for this business (wrong tenant, wrong conversation, another direction) does nothing, and calls nothing", async () => {
    const s = setup({ message: null });
    expect(await run(s)).toEqual({ status: "skipped", reason: "not_found" });
    expect(s.loadConnection).not.toHaveBeenCalled();
    expect(s.fetchFn).not.toHaveBeenCalled();
  });

  it.each(["text", "audio", "location", "interactive", "unsupported", "video"])("a %s message is not media to save", async (kind) => {
    const s = setup({ message: message({ kind }) });
    expect(await run(s)).toEqual({ status: "skipped", reason: "not_media" });
    expect(s.fetchFn).not.toHaveBeenCalled();
  });

  it("a media message with no media id (or no media at all) has nothing to fetch", async () => {
    for (const media of [null, {}, { mime: "image/jpeg" }, { id: 5 }]) {
      const s = setup({ message: message({ media }) });
      expect(await run(s)).toEqual({ status: "skipped", reason: "no_media_id" });
      expect(s.fetchFn).not.toHaveBeenCalled();
    }
  });

  it("no usable connection for this business and channel (the shared demo number, a disconnected number) skips, writes nothing and calls Meta not at all", async () => {
    const s = setup({ connection: async () => null });
    expect(await run(s)).toEqual({ status: "skipped", reason: "no_connection" });
    expect(s.fetchFn).not.toHaveBeenCalled();
    expect(s.saveMedia).not.toHaveBeenCalled();
  });

  it.each([
    ["a value that is not an encrypted token", () => "not-encrypted"],
    ["a token encrypted for another connection", () => encryptSecret(TOKEN, connectionSecretContext({ column: "token_enc", tenantId: TENANT, connectionId: "d4000000-0000-4000-8000-0000000000a2" }), env)],
    ["a token encrypted for another business", () => encryptSecret(TOKEN, connectionSecretContext({ column: "token_enc", tenantId: OTHER_TENANT, connectionId: CONNECTION }), env)],
  ])("%s cannot be used: skipped, nothing is called", async (_name, make) => {
    const s = setup({ connection: async () => ({ connectionId: CONNECTION, tokenEnc: make() }) });
    expect(await run(s)).toEqual({ status: "skipped", reason: "token_unusable" });
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
});

describe("running twice", () => {
  it("a message that already has its file does nothing: no Graph call, no upload, no write", async () => {
    const s = setup({ message: message({ media: { id: "media-1", mime: "image/jpeg", path: PATH("jpg"), size: 8, storedAt: "2026-10-14T00:00:00.000Z" } }) });
    expect(await run(s)).toEqual({ status: "done" });
    expect(s.loadConnection).not.toHaveBeenCalled();
    expect(s.fetchFn).not.toHaveBeenCalled();
    expect(s.upload).not.toHaveBeenCalled();
    expect(s.saveMedia).not.toHaveBeenCalled();
  });

  it.each([{ skipped: "too_big" }, { unavailable: "media_gone" }])("a message already decided (%j) is not asked about again", async (mark) => {
    const s = setup({ message: message({ media: { id: "media-1", mime: "image/jpeg", ...mark } }) });
    expect(await run(s)).toEqual({ status: "done" });
    expect(s.fetchFn).not.toHaveBeenCalled();
    expect(s.saveMedia).not.toHaveBeenCalled();
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts).
  it("replay: the same event twice, the second run finding the first one's record, saves one file at one path", async () => {
    const stored: Record<string, unknown>[] = [];
    let current: MediaMessage = message();
    const s = setup({
      save: async (_t, _m, media) => {
        stored.push(media);
        current = { ...current, media };
      },
    });
    s.loadMessage.mockImplementation(async () => current);
    expect(await run(s)).toEqual({ status: "stored" });
    expect(await run(s)).toEqual({ status: "done" });
    expect(s.upload).toHaveBeenCalledTimes(1);
    expect(s.fetchFn).toHaveBeenCalledTimes(2);
    expect(stored).toHaveLength(1);
  });

  it("a retry after the upload worked but the record failed uploads to the same path again (an overwrite, not a second file) and then records", async () => {
    let fail = true;
    const s = setup({
      save: async () => {
        if (fail) {
          fail = false;
          throw new Error("database down");
        }
      },
    });
    await expect(run(s)).rejects.toThrow();
    expect(await run(s)).toEqual({ status: "stored" });
    expect(s.upload.mock.calls.map((c) => c[0])).toEqual([PATH("jpg"), PATH("jpg")]);
  });

  it("a lookup that fails (the message, the connection) is thrown to be retried with a fixed text, nothing of the database's words", async () => {
    for (const which of ["loadMessage", "loadConnection"] as const) {
      const s = setup();
      s[which].mockImplementation(async () => Promise.reject(new Error(`row for ${TOKEN}`)));
      const error = await run(s).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(MediaRetryError);
      expect(error?.message).not.toContain(TOKEN);
      expect(s.fetchFn).not.toHaveBeenCalled();
    }
  });

  it("an upload that fails is thrown to be retried, and nothing is recorded as saved", async () => {
    const s = setup({ upload: async () => Promise.reject(new Error(`storage said no for ${TOKEN}`)) });
    const error = await run(s).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(MediaRetryError);
    expect(error?.message).not.toContain(TOKEN);
    expect(s.saveMedia).not.toHaveBeenCalled();
  });
});

describe("tenant isolation", () => {
  it("every lookup is made with the business from the event, and the path starts with that business", async () => {
    const s = setup();
    await run(s);
    expect(s.loadMessage).toHaveBeenCalledWith(TENANT, CONV, MESSAGE);
    expect(s.loadConnection).toHaveBeenCalledWith(TENANT, CHANNEL);
    expect(s.saveMedia.mock.calls[0][0]).toBe(TENANT);
    expect(s.upload.mock.calls[0][0].startsWith(`${TENANT}/`)).toBe(true);
  });

  it("an event that names another business than the message's finds no message (the lookup filters by it) and uses no token", async () => {
    const s = setup({ message: null });
    await downloadMessageMedia({ ...IDS, tenantId: OTHER_TENANT }, s.deps);
    expect(s.loadMessage).toHaveBeenCalledWith(OTHER_TENANT, CONV, MESSAGE);
    expect(s.loadConnection).not.toHaveBeenCalled();
  });

  it("refuses ids that are not ids before any lookup, so no path can step outside the business's folder", async () => {
    for (const bad of [{ ...IDS, tenantId: "../other" }, { ...IDS, conversationId: "x/../../y" }, { ...IDS, messageId: `${MESSAGE}/..` }]) {
      const s = setup();
      await expect(downloadMessageMedia(bad, s.deps)).rejects.toThrow();
      expect(s.loadMessage).not.toHaveBeenCalled();
    }
  });
});

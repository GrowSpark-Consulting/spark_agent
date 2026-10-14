import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { handleMediaDownload } from "../inngest/media-download";
import { connectionSecretContext, encryptSecret } from "../lib/crypto";
import { downloadMessageMedia, type DownloadDeps } from "../media/download";
import { captureLogs, describeLeaks, poison, type Fixtures, type LogCapture } from "./detect";

// Day 7, PR F: the log sweep over the media download. The real download and the real Inngest handler run on a fake Graph API and fake storage whose answers
// and failures carry the poison (a phone number, the token, the address Meta hands out, a file name, a caption). Every console line is searched for the
// customer's number, the token, the secrets, the address and the canary words, and so is the text of every error the job throws (Inngest prints that itself).
// NOT PROVED: the real Meta (every answer here is made up), real storage, staging logs.

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const CONV = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const MESSAGE = "8e9f0a1b-2c3d-4e5f-8a7b-9c0d1e2f3a4b";
const CONNECTION = "d4000000-0000-4000-8000-0000000000a1";
const TOKEN = "EAABsyntheticAccessTokenForTheMediaSweep0001";
const PHONE = "+919812345621";
const ADDRESS_SECRET = "SYNTHETICSIGNEDADDRESSKEY0123456789ABCDEF";
const FILE_URL = `https://lookaside.example.test/file.jpg?hash=${ADDRESS_SECRET}`;
const KEY = randomBytes(32).toString("base64");
const env = { ENCRYPTION_KEY: KEY, META_GRAPH_API_VERSION: "v26.0" };
const FX: Fixtures = { phones: [PHONE, "+91 98123 45621"], secrets: [TOKEN, KEY, ADDRESS_SECRET, FILE_URL], texts: ["CANARY-CAPTION-7QX", "CANARY-FILENAME-3LM"] };
const POISON = poison(FX);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const tokenEnc = () => encryptSecret(TOKEN, connectionSecretContext({ column: "token_enc", tenantId: TENANT, connectionId: CONNECTION }), env);

let capture: LogCapture | undefined;
afterEach(() => {
  capture?.stop();
  capture = undefined;
});

type Fetch = (url: string) => Promise<Response>;
const lookup = (over: Record<string, unknown> = {}) => Response.json({ url: FILE_URL, mime_type: "image/jpeg", file_size: 8, id: "m1", caption: "CANARY-CAPTION-7QX", filename: "CANARY-FILENAME-3LM", from: PHONE, ...over });
const ok: Fetch = async (url) => (url.startsWith("https://graph.facebook.com") ? lookup() : new Response(JPEG as unknown as ArrayBuffer));

function deps(over: Partial<DownloadDeps> & { fetchFn?: Fetch } = {}): DownloadDeps {
  const { fetchFn, ...rest } = over;
  return {
    loadMessage: async () => ({ kind: "image", channelId: "c1", media: { id: "m1", mime: "image/jpeg", filename: "CANARY-FILENAME-3LM" } }),
    loadConnection: async () => ({ connectionId: CONNECTION, tokenEnc: tokenEnc() }),
    saveMedia: async () => undefined,
    upload: async () => undefined,
    fetch: (fetchFn ?? ok) as unknown as typeof fetch,
    env,
    timeoutMs: 100,
    ...rest,
  };
}

/** Runs the job; returns what it threw (or null). Checks every logged line, and every thrown message, for a leak. */
async function sweep(d: DownloadDeps, atLeast = 1): Promise<Error | null> {
  capture = captureLogs();
  let thrown: Error | null = null;
  try {
    await handleMediaDownload({ event: { data: { tenantId: TENANT, conversationId: CONV, messageId: MESSAGE } }, step: { run: (_id, fn) => fn() } }, { download: (ids) => downloadMessageMedia(ids, d) });
  } catch (err) {
    thrown = err as Error;
  }
  const cap = capture;
  expect(cap.lines().length, "the job wrote fewer lines than it should: the sweep proves nothing").toBeGreaterThanOrEqual(atLeast);
  expect(cap.leaks(FX), `\n${describeLeaks(cap.leaks(FX))}`).toEqual([]);
  if (thrown) expect(JSON.stringify([thrown.name, thrown.message, thrown.stack?.split("\n")[0]]), "the thrown error carries something private").not.toMatch(/9198|98123|EAAB|SYNTHETIC|CANARY|lookaside|example\.test/);
  return thrown;
}

describe("the media download writes no number, token, address, caption or file name to a log or an error", () => {
  it("a file saved", async () => {
    expect(await sweep(deps())).toBeNull();
  });

  it("a file already saved", async () => {
    await sweep(deps({ loadMessage: async () => ({ kind: "image", channelId: "c1", media: { id: "m1", mime: "image/jpeg", path: "p" } }) }));
  });

  it("a type not allowed, a file too big (by size and by bytes), a file that is not what its type says", async () => {
    await sweep(deps({ fetchFn: async (url) => (url.startsWith("https://graph.facebook.com") ? lookup({ mime_type: "image/svg+xml" }) : new Response(JPEG as unknown as ArrayBuffer)) }));
    await sweep(deps({ fetchFn: async (url) => (url.startsWith("https://graph.facebook.com") ? lookup({ file_size: 99_999_999 }) : new Response(JPEG as unknown as ArrayBuffer)) }));
    await sweep(deps({ fetchFn: async (url) => (url.startsWith("https://graph.facebook.com") ? lookup({ file_size: 8 }) : new Response(new Uint8Array(6 * 1024 * 1024).fill(0xff) as unknown as ArrayBuffer, { headers: { "content-length": "1" } })) }));
    await sweep(deps({ fetchFn: async (url) => (url.startsWith("https://graph.facebook.com") ? lookup() : new Response(`MZ ${POISON}`)) }));
  });

  it.each([400, 401, 403, 404, 410, 418, 429, 500, 503])("Meta answering HTTP %i with a body full of the poison", async (status) => {
    await sweep(deps({ fetchFn: async () => Response.json({ error: { message: POISON, code: 190, fbtrace_id: POISON } }, { status }) }));
  });

  it("Meta's file address answering with the poison", async () => {
    await sweep(deps({ fetchFn: async (url) => (url.startsWith("https://graph.facebook.com") ? lookup() : new Response(POISON, { status: 500 })) }));
    await sweep(deps({ fetchFn: async (url) => (url.startsWith("https://graph.facebook.com") ? lookup() : new Response(POISON, { status: 404 })) }));
  });

  it("answers that are not what Meta documents, and an address that is not a safe one", async () => {
    await sweep(deps({ fetchFn: async () => new Response(POISON) }));
    await sweep(deps({ fetchFn: async () => lookup({ url: `http://127.0.0.1/${ADDRESS_SECRET}?from=${PHONE}` }) }));
  });

  it("a fetch that throws with the poison, and one that never answers", async () => {
    expect(await sweep(deps({ fetchFn: async () => Promise.reject(new Error(POISON)) }))).not.toBeNull();
    expect(await sweep(deps({ fetchFn: () => new Promise<Response>(() => undefined) }))).not.toBeNull();
  });

  it("storage and the database failing with the poison", async () => {
    expect(await sweep(deps({ upload: async () => Promise.reject(new Error(POISON)) }))).not.toBeNull();
    expect(await sweep(deps({ saveMedia: async () => Promise.reject(new Error(POISON)) }))).not.toBeNull();
    expect(await sweep(deps({ loadMessage: async () => Promise.reject(new Error(POISON)) }))).not.toBeNull();
    expect(await sweep(deps({ loadConnection: async () => Promise.reject(new Error(POISON)) }))).not.toBeNull();
  });

  it("a token that cannot be decrypted, no connection, no message", async () => {
    await sweep(deps({ loadConnection: async () => ({ connectionId: CONNECTION, tokenEnc: `v1:${POISON}` }) }));
    await sweep(deps({ loadConnection: async () => null }));
    await sweep(deps({ loadMessage: async () => null }));
  });

  it("a voice note or a text (not media to save)", async () => {
    await sweep(deps({ loadMessage: async () => ({ kind: "audio", channelId: "c1", media: { id: "m1", mime: "audio/ogg" } }) }));
  });
});

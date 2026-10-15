import type { SupabaseClient } from "@supabase/supabase-js";

// Signed links for a customer's photo or document in the private `message-media` bucket (migration 0047; the download job in
// backend/src/media/download.ts writes `messages.media.path` as <business id>/<chat id>/<message id>.<ext>).
//
// What keeps this safe, in order:
//   1. Only a path of exactly that shape, for THIS business and THIS chat, is ever signed. A path that is anything else (another folder, "..",
//      a leading slash, a URL) is treated as no file at all. The server wrote the path, but a row is data: it is checked before it is used.
//   2. The link is made with the member's own session. Storage applies 0047's `message_media_member_read` policy, which lets a member read
//      only objects whose first folder is a business they belong to. So even a path that slipped past step 1 could not read another business's file.
//   3. The path is never shown or linked as an address. Only the signed link is used, and only inside an <img> or a link the person presses.
//   4. A link lives for an hour; it is kept and reused while it has more than five minutes left, so a re-render never asks for a new one.
//      Nothing here logs a link, stores it in the page's storage or sends it anywhere.

export const BUCKET = "message-media";
export const SIGNED_URL_SECONDS = 3600;
/** A link with less than this left is not reused: it could run out while a person is looking at it. */
export const REUSE_MARGIN_MS = 5 * 60_000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** What the browser may draw as a picture. SVG and anything else is never put in an <img> from here; the job only stores these. */
export const INLINE_IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

/**
 * The object path to sign, or null when `path` is not a file of this chat. The match is case-insensitive on the ids, and the returned
 * path is the one given (storage paths are case-sensitive; the job writes lower case).
 */
export function storedMediaPath(path: unknown, tenantId: string, conversationId: string): string | null {
  if (typeof path !== "string") return null;
  const wanted = new RegExp(`^${tenantId.toLowerCase()}/${conversationId.toLowerCase()}/${UUID}\\.[a-z0-9]{1,8}$`);
  return /^[0-9a-f-]{36}$/i.test(tenantId) && /^[0-9a-f-]{36}$/i.test(conversationId) && wanted.test(path.toLowerCase()) ? path : null;
}

export type Signer = (path: string) => Promise<string>;

/** Signs with the member's session. Throws (with no link in the message) when storage refuses or answers without a link. */
export function storageSigner(supabase: SupabaseClient): Signer {
  return async (path) => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
    if (error || !data?.signedUrl) throw new Error("message media: could not sign the file");
    return data.signedUrl;
  };
}

/**
 * One signed link per path, shared by everything that asks for it: while one is being made a second ask waits for the same answer, and a made
 * link is reused until it is close to expiring. A failure is not remembered, so the next ask tries again.
 */
export function createSignedUrlCache(sign: Signer, now: () => number = Date.now) {
  const made = new Map<string, { url: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string>>();
  return {
    get(path: string): Promise<string> {
      const hit = made.get(path);
      if (hit && hit.expiresAt - now() > REUSE_MARGIN_MS) return Promise.resolve(hit.url);
      const running = pending.get(path);
      if (running) return running;
      const started = now();
      const request = sign(path)
        .then((url) => {
          made.set(path, { url, expiresAt: started + SIGNED_URL_SECONDS * 1000 });
          return url;
        })
        .finally(() => pending.delete(path));
      pending.set(path, request);
      return request;
    },
    /** The link did not work (it expired, or was refused): the next ask makes a new one. */
    forget(path: string) {
      made.delete(path);
    },
  };
}

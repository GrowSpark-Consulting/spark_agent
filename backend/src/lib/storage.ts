import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// Where a customer's photos, voice notes and documents are kept once downloaded from WhatsApp (migration 0047; agreed with
// Dev 1, 14 Oct): the private bucket message-media, at <tenant_id>/<conversation_id>/<message_id>.<ext>. Only the server
// writes (the service role); a member of the business reads its own files (the policy reads the first folder as the
// business), so the path must always start with the business's id. Build it here, never by hand.

export const MESSAGE_MEDIA_BUCKET = "message-media";

const Id = z.guid();

/** WhatsApp's media types and the extension a file of each is stored under; anything else is stored as .bin. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** The extension for a media type as WhatsApp gives it ("audio/ogg; codecs=opus" is audio/ogg). */
export function mediaExtension(mimeType: string | null | undefined): string {
  const base = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  return EXTENSIONS[base] ?? "bin";
}

/** The object's path in message-media. Throws on anything that is not an id or a plain extension, so no path can step outside its business. */
export function messageMediaPath(tenantId: string, conversationId: string, messageId: string, extension: string): string {
  for (const [what, id] of [
    ["business", tenantId],
    ["conversation", conversationId],
    ["message", messageId],
  ] as const) {
    if (!Id.safeParse(id).success) throw new Error(`message media: the ${what} id is not an id`);
  }
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error("message media: the extension must be 1 to 8 lowercase letters or digits");
  return `${tenantId.toLowerCase()}/${conversationId.toLowerCase()}/${messageId.toLowerCase()}.${extension}`;
}


/** Files removed at a time: the Storage API takes a list of paths per call. */
const REMOVE_BATCH = 100;

/**
 * The paths of a business's files in message-media: all of them, or those of some chats (0048 media_object_names). Read from storage by the
 * path's own folders, so it still finds them after the rows that named them are deleted. An empty list of chats has no files.
 */
export async function messageMediaNames(db: SupabaseClient, tenantId: string, conversationIds: readonly string[] | null = null): Promise<string[]> {
  if (conversationIds !== null && conversationIds.length === 0) return [];
  const { data, error } = await db.rpc("media_object_names", { p_tenant_id: tenantId, p_conversation_ids: conversationIds });
  if (error) throw new Error("message media: listing the files failed");
  return z.array(z.string()).parse(data ?? []);
}

/**
 * Removes these files through the Storage API (storage refuses a direct DELETE, and deleting rows does not touch it). Never throws: a batch that
 * fails is counted as left, and the caller decides (a job retries; a deletion request reports it).
 */
export async function removeMessageMedia(db: SupabaseClient, paths: readonly string[]): Promise<{ removed: number; left: number }> {
  const counts = { removed: 0, left: 0 };
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const batch = paths.slice(i, i + REMOVE_BATCH);
    try {
      const { error } = await db.storage.from(MESSAGE_MEDIA_BUCKET).remove([...batch]);
      if (error) throw error;
      counts.removed += batch.length;
    } catch {
      counts.left += batch.length;
    }
  }
  return counts;
}

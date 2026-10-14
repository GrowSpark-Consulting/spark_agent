import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { serverEnv } from "../lib/env";
import { MESSAGE_MEDIA_BUCKET } from "../lib/storage";
import { supabaseAdmin } from "../lib/supabase-admin";
import type { DownloadDeps } from "./download";

// The database and storage side of the media download. Service role, server only; every query names the business. A failure carries a fixed word
// (never the database's text, which can hold values), so the step is retried by Inngest without anything private in its log.

type Store = Pick<DownloadDeps, "loadMessage" | "loadConnection" | "saveMedia" | "upload">;

const MessageRow = z.object({ kind: z.string().nullable(), media: z.unknown() });
const ConversationRow = z.object({ channel_id: z.string() });
const ConnectionRow = z.object({ id: z.string(), token_enc: z.string().min(1) });

class MediaDbError extends Error {
  constructor(operation: string) {
    super(`media ${operation} failed`);
    this.name = "MediaDbError";
  }
}

export type StorageWriter = (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;

export function mediaDb(db: SupabaseClient, write: StorageWriter): Store {
  return {
    async loadMessage(tenantId, conversationId, messageId) {
      const { data, error } = await db
        .from("messages")
        .select("kind, media")
        .eq("tenant_id", tenantId)
        .eq("id", messageId)
        .eq("conversation_id", conversationId)
        .eq("direction", "in")
        .eq("sender", "customer")
        .maybeSingle();
      if (error) throw new MediaDbError("message lookup");
      if (!data) return null;
      const message = MessageRow.parse(data);
      const chat = await db.from("conversations").select("channel_id").eq("tenant_id", tenantId).eq("id", conversationId).maybeSingle();
      if (chat.error) throw new MediaDbError("chat lookup");
      if (!chat.data) return null;
      const media = message.media !== null && typeof message.media === "object" && !Array.isArray(message.media) ? (message.media as Record<string, unknown>) : null;
      return { kind: message.kind ?? "", channelId: ConversationRow.parse(chat.data).channel_id, media };
    },

    async loadConnection(tenantId, channelId) {
      const { data, error } = await db
        .from("whatsapp_connections")
        .select("id, token_enc")
        .eq("tenant_id", tenantId)
        .eq("channel_id", channelId)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (error) throw new MediaDbError("connection lookup");
      const row = ConnectionRow.safeParse(data);
      return row.success ? { connectionId: row.data.id, tokenEnc: row.data.token_enc } : null;
    },

    async saveMedia(tenantId, messageId, media) {
      const { data, error } = await db.from("messages").update({ media }).eq("tenant_id", tenantId).eq("id", messageId).select("id");
      if (error) throw new MediaDbError("record");
      if (!Array.isArray(data) || data.length === 0) throw new MediaDbError("record");
    },

    upload: write,
  };
}

/** The real thing: the service-role client, the private bucket (an overwrite at a fixed path), and the server's own environment. */
export function realDownloadDeps(): DownloadDeps {
  const admin = supabaseAdmin();
  const env = serverEnv();
  const store = mediaDb(admin, async (path, bytes, contentType) => {
    const { error } = await admin.storage.from(MESSAGE_MEDIA_BUCKET).upload(path, bytes, { contentType, upsert: true });
    if (error) throw new MediaDbError("upload");
  });
  return { ...store, fetch, env };
}

# 14 Oct (Dev 1): the photos and documents customers send are saved to storage (Day 7, PR F)

Dev 1 files only (`backend/src/media/` new, `backend/src/inngest/media-download.ts` new, tests). Small additions to two shared files: one line in `inngest/functions.ts` (registers the function) and one entry in `inngest/replay-coverage.test.ts` (its replay proofs). One addition in `channels/whatsapp/inbound.ts` (the event). No migration, no table, no RPC, no change to `lib/storage.ts`. No environment file was read; every token, id and file in the tests is made up.

## 1. What it does

- After the webhook stores an image or document message and queues `whatsapp/message.received`, it queues `whatsapp/media.received` (ids only, event id `media_received:<messageId>`). Voice notes, texts, buttons, locations and unsupported types queue nothing. A failure to queue it answers 500, like the first event, and Meta's retry queues it again.
- `media-download` (Inngest, 4 retries, 5 at a time) loads the customer's inbound message by `tenant_id`, conversation and message id, finds the business's active connection for the chat's channel, decrypts its token (same context as the send adapter) and makes two Graph calls: `GET /{version}/{media-id}` for `{ url, mime_type, file_size }`, then a GET of that url with the same token. **Both calls follow Meta's documentation and are unverified against Meta.**
- The file is uploaded with the service role to `messageMediaPath(tenant, conversation, message, mediaExtension(mime))` in `message-media` (`upsert: true`), and `messages.media` is rewritten with its old keys (`id`, `mime`, ...) plus `path`, `size`, `storedAt`.
- It sends nothing to the customer and never touches the reply.

## 2. Limits

- Type is Meta's own `mime_type`, not the webhook's. Images: jpeg, png, webp, 5 MB. Documents: pdf, txt, doc, docx, xls, xlsx, ppt, pptx, 20 MB. The type must fit the kind. Anything else is not stored.
- Size is checked three times: Meta's declared `file_size`, the `Content-Length` header, and the bytes actually read (the read stops and drops the rest at the cap).
- The first bytes of jpeg, png, webp and pdf must match; a file with no bytes is refused.
- The address Meta hands out must be https, with no login, no address literal and no single-label or `.local` host, or it is never fetched (the token is not sent there). A media id from the webhook must be 1 to 64 letters, digits, `_` or `-`.
- Not followed up: redirects on the file address are the platform's default, so the token stays only on the first host (Node strips it on a cross-origin redirect); not verified.

## 3. What is written on the message when a file is not saved

Written in `messages.media`, so no later run asks Meta again: `skipped: "type_not_allowed" | "too_big"`, `unavailable: "media_gone"` (400, 404 or 410), `"rejected"` (any other 4xx) or `"bad_answer"` (an answer that is not the documented shape, or an unsafe address). **Not written** (the file may still be saved after a reconnect or a retry): no connection for the business and channel (this includes the shared demo number, whose connection belongs to the front desk), a token that cannot be decrypted, a token Meta refuses (401, 403), a message that is not found or is not an image or document. A timeout, a network error, a 429, a 5xx, an upload failure and a failure to record are thrown as `MediaRetryError` (a fixed text), so Inngest retries.

## 4. Running twice

A message with `path`, `skipped` or `unavailable` already in `media` is left alone: no Graph call, no upload, no write. A retry after an upload that worked but a record that failed uploads to the same path (an overwrite) and then records. The Inngest event id drops a duplicate event.

## 5. The link to the lead

None stored. A lead belongs to a contact (`leads.contact_id`) and a message to a conversation of that contact, which is how the screens already find a contact's lead; the path starts with the business, conversation and message ids.

## 6. Logs

One line per run, words only: `[media-download] outcome=stored|done|skipped|unavailable [reason=<word>]`, `outcome=retry reason=<word>`, or `outcome=failed kind=<error name>`. No id, media id, address, path, type, caption, file name, number or token. Errors thrown carry fixed words. `log-sweep/media-sweep.test.ts` runs the real job on a fake Graph and fake storage whose answers and failures carry a phone number, the token, the signed address, a caption and a file name; it searches every console line and every thrown error. The sweep found one leak while being written (a lookup that threw a raw database error would have reached Inngest's own log); the job now wraps lookups.

## 7. Tests

`media/download.test.ts` (73: the saves, every limit, every Graph answer, replay, tenant isolation), `media/db.test.ts` (every query names the business; the token is read only for the one active connection), `inngest/media-download.test.ts` (event, log lines, registration), `log-sweep/media-sweep.test.ts` (18), nine in `server/webhook-post.test.ts` (which events a message queues). Checked to be able to fail: removing the magic-byte check, the byte counter, and the tenant filter on the update each turned tests red.

## 8. Not proved

The real Meta (every Graph answer is made up; the shape of the lookup answer, the `Authorization` header on the file address and the lifetime of a media id are assumptions from the documentation); real storage (the upload is faked; the RLS read of the bucket is Dev 2's test, `supabase/tests/message_media.test.sql`); a voice note (not saved by choice); where staff see the file (the inbox shows an attachment label only; a signed URL from `media.path` would be new UI).

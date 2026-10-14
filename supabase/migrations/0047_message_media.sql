-- 0047_message_media: where a customer's photos, voice notes and documents are kept once downloaded from WhatsApp (Day 7;
-- agreed with Dev 1, 14 Oct; her download job writes here, backend/src/lib/storage.ts has the path).
--
--   message-media/<tenant_id>/<conversation_id>/<message_id>.<ext>
--
--   * Private: no public URLs. The dashboard reads with the member's own session (or a signed URL the server makes).
--   * Read: a member of the business named by the path's first folder, and nobody else (row-level security on
--     storage.objects). A path whose first folder is not a business id is readable by no one.
--   * Written only by the server (the service role bypasses row-level security): no insert, update or delete policy exists,
--     so no browser can add, replace or remove a file.
--   * 50 MB a file (the Supabase plan's own ceiling); any type, since WhatsApp sends images, audio, video and documents.
-- A contact's data deletion (0043) and a business's deletion must also remove its files: the server lists and deletes them
-- (the storage API), since deleting the rows does not touch storage.

insert into storage.buckets (id, name, public, file_size_limit)
values ('message-media', 'message-media', false, 52428800)
on conflict (id) do nothing;

-- The first folder of an object's path, read as a business id only when it is one: the CASE checks before it casts, and a
-- path that does not start with an id gives null, which is_member refuses. Inline, so a signed-in user still calls no
-- function but is_member and is_admin (supabase/tests/isolation.test.sql).
create policy message_media_member_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'message-media'
    and public.is_member(
      case
        when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then ((storage.foldername(name))[1])::uuid
      end
    )
  );

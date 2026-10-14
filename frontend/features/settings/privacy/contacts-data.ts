import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { maskPhoneForDisplay } from "@/features/inbox/data";

// Who can be picked on Settings → Data & privacy. The deletion API takes a contact id and there is no route that lists or searches contacts, so
// the screen reads `contacts` as the signed-in member under row-level security, filtered by business, the way the inbox and the leads board do.
// Only the id, the name and a masked number are ever shown; the full number is read for searching and is never rendered or logged. A contact whose
// data was already deleted is scrubbed to a `deleted:<id>` number and left out of the list.

export const CONTACT_LIMIT = 200;

const Row = z.object({ id: z.guid(), name: z.string().nullable(), phone: z.string() });

export class ContactsDataError extends Error {
  constructor() {
    super("The customer list was not in the shape the screen expects");
    this.name = "ContactsDataError";
  }
}

export interface ContactChoice {
  id: string;
  /** The name, or the masked number when there is none. */
  label: string;
  /** Always masked. Null when the label already is the masked number. */
  maskedPhone: string | null;
  /** Digits of the full number, for the search box only. */
  searchDigits: string;
}

export async function fetchContacts(client: SupabaseClient, tenantId: string): Promise<ContactChoice[]> {
  const { data, error } = await client
    .from("contacts")
    .select("id, name, phone")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(CONTACT_LIMIT);
  if (error) throw error;
  const parsed = z.array(Row).safeParse(data ?? []);
  if (!parsed.success) throw new ContactsDataError();
  return parsed.data
    .filter((c) => !c.phone.startsWith("deleted:"))
    .map((c) => {
      const masked = maskPhoneForDisplay(c.phone);
      const name = c.name?.trim() || null;
      return { id: c.id, label: name ?? masked, maskedPhone: name ? masked : null, searchDigits: c.phone.replace(/\D/g, "") };
    });
}

/** The contacts whose name or number contains what was typed. Digits in the query match the number; anything else matches the name. */
export function filterContacts(contacts: ContactChoice[], query: string): ContactChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return contacts;
  const digits = q.replace(/\D/g, "");
  return contacts.filter((c) => c.label.toLowerCase().includes(q) || (digits.length >= 3 && c.searchDigits.includes(digits)));
}

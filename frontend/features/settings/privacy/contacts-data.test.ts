import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { ContactsDataError, fetchContacts, filterContacts, type ContactChoice } from "./contacts-data";

const TENANT = "10000000-0000-0000-0000-000000000004";
const id = (n: number) => `20000000-0000-0000-0000-00000000000${n}`;

function clientReturning(result: { data: unknown; error: unknown }, seen: { filters: string[] } = { filters: [] }): SupabaseClient {
  const q = {
    select: (c: string) => (seen.filters.push(`select ${c}`), q),
    eq: (c: string, v: string) => (seen.filters.push(`eq ${c} ${v}`), q),
    order: () => q,
    limit: (n: number) => (seen.filters.push(`limit ${n}`), Promise.resolve(result)),
  };
  return { from: (table: string) => (seen.filters.push(`from ${table}`), q) } as unknown as SupabaseClient;
}

describe("fetchContacts", () => {
  it("reads one business's contacts, newest first, at most 200", async () => {
    const seen = { filters: [] as string[] };
    await fetchContacts(clientReturning({ data: [], error: null }, seen), TENANT);
    expect(seen.filters).toEqual(["from contacts", "select id, name, phone", `eq tenant_id ${TENANT}`, "limit 200"]);
  });

  it("shows the name, or the masked number when there is none, and never the full number", async () => {
    const rows = [
      { id: id(1), name: "Karthik R", phone: "+919812345621" },
      { id: id(2), name: null, phone: "+919000000052" },
    ];
    const list = await fetchContacts(clientReturning({ data: rows, error: null }), TENANT);
    expect(list[0]).toMatchObject({ label: "Karthik R", maskedPhone: "+91 98xxx xxx21" });
    expect(list[1]).toMatchObject({ label: "+91 90xxx xxx52", maskedPhone: null });
    for (const c of list) {
      expect(c.label).not.toContain("9812345621");
      expect(c.maskedPhone ?? "").not.toContain("9812345621");
    }
  });

  it("leaves out a contact whose data was already deleted", async () => {
    const rows = [{ id: id(1), name: null, phone: `deleted:${id(1)}` }, { id: id(2), name: "Priya S", phone: "+919900000037" }];
    expect((await fetchContacts(clientReturning({ data: rows, error: null }), TENANT)).map((c) => c.id)).toEqual([id(2)]);
  });

  it("is an error, not an empty list, when the read fails or the rows are the wrong shape", async () => {
    const failure = new Error("boom");
    await expect(fetchContacts(clientReturning({ data: null, error: failure }), TENANT)).rejects.toBe(failure);
    await expect(fetchContacts(clientReturning({ data: [{ id: "x", name: 1 }], error: null }), TENANT)).rejects.toBeInstanceOf(ContactsDataError);
  });
});

describe("filterContacts", () => {
  const list: ContactChoice[] = [
    { id: id(1), label: "Karthik R", maskedPhone: "+91 98xxx xxx21", searchDigits: "919812345621" },
    { id: id(2), label: "Priya S", maskedPhone: "+91 99xxx xxx37", searchDigits: "919900000037" },
  ];
  it("matches the name, or at least three digits of the number", () => {
    expect(filterContacts(list, "").length).toBe(2);
    expect(filterContacts(list, "priya").map((c) => c.id)).toEqual([id(2)]);
    expect(filterContacts(list, "98123").map((c) => c.id)).toEqual([id(1)]);
    expect(filterContacts(list, "98")).toEqual([]);
    expect(filterContacts(list, "nobody")).toEqual([]);
  });
});

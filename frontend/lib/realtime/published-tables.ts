// The tables the database actually sends Realtime changes for: the supabase_realtime publication, as the migrations
// build it (0010_inbox_realtime: messages, conversations, handoffs; 0011_knowledge_base: kb_documents).
//
// Subscribing to a table that is NOT in the publication succeeds and then delivers nothing, forever, so a screen would
// show "live" while never hearing a change. Screens therefore ask for the tables they care about and only the published
// ones are subscribed to; the rest are reported as not live, and the screen's Refresh button is the way to update.
//
// `leads` and `bookings` are NOT here: no migration publishes them (a Dev 2 migration, see the regression matrix). The
// day one does, add the table to this list. A test (published-tables.test.ts) reads the migrations and fails the moment
// they and this list disagree, so the list can neither run ahead of the database nor fall behind it unnoticed. Even
// then, Realtime working on a real database is unverified until it has been seen on staging.

export const PUBLISHED_TABLES = ["messages", "conversations", "handoffs", "kb_documents"] as const;
export type PublishedTable = (typeof PUBLISHED_TABLES)[number];

export const isPublishedTable = (table: string): table is PublishedTable => (PUBLISHED_TABLES as readonly string[]).includes(table);

/** The requested tables the database publishes, without repeats, in the order asked. */
export function watchableTables(requested: readonly string[]): PublishedTable[] {
  return [...new Set(requested)].filter(isPublishedTable);
}

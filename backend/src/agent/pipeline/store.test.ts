import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/errors";
import { NonRetriableError } from "inngest";
import { createPipelineStore } from "./store";

// The service-role queries of the message pipeline. The client is a recorder that answers with what each test
// says, so what is sent can be checked without a database: every query names its business, errors carry
// nothing the database said, and a call that never answers ends.

const T = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const MSG = "a0000000-0000-0000-0000-0000000000a1";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "d0000000-0000-0000-0000-0000000000d1";

type Answer = { data?: unknown; error?: { code?: string; message: string } | null };
interface Call {
  table: string;
  op: "select" | "insert" | "update" | "rpc";
  payload?: unknown;
  /** rpc: the function's name and its arguments */
  fn?: string;
  args?: Record<string, unknown>;
  returning?: string;
  filters: [string, string, unknown][];
  order?: [string, boolean];
  limit?: number;
  terminal?: string;
  signal?: AbortSignal;
}

function fakeDb(answer: (call: Call) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const db = {
    rpc(fn: string, args: Record<string, unknown>) {
      return makeBuilder({ table: "", op: "rpc", filters: [], fn, args });
    },
    from(table: string) {
      return makeBuilder({ table, op: "select", filters: [] });
    },
  };
  function makeBuilder(call: Call) {
    {
      const builder: Record<string, unknown> = {
        select: (columns?: string) => ((call.returning ??= columns ?? "*"), builder),
        insert: (payload: unknown) => ((call.op = "insert"), (call.payload = payload), builder),
        update: (payload: unknown) => ((call.op = "update"), (call.payload = payload), builder),
        lt: (c: string, v: unknown) => (call.filters.push([c, "lt", v]), builder),
        eq: (c: string, v: unknown) => (call.filters.push([c, "eq", v]), builder),
        gte: (c: string, v: unknown) => (call.filters.push([c, "gte", v]), builder),
        in: (c: string, v: unknown) => (call.filters.push([c, "in", v]), builder),
        not: (c: string, op: string, v: unknown) => (call.filters.push([c, `not.${op}`, v]), builder),
        is: (c: string, v: unknown) => (call.filters.push([c, "is", v]), builder),
        order: (c: string, o?: { ascending?: boolean }) => ((call.order = [c, o?.ascending ?? true]), builder),
        limit: (n: number) => ((call.limit = n), builder),
        abortSignal: (signal: AbortSignal) => ((call.signal = signal), builder),
        single: () => ((call.terminal = "single"), builder),
        maybeSingle: () => ((call.terminal = "maybeSingle"), builder),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          calls.push(call);
          return Promise.resolve(answer(call)).then((a) => ({ data: a.data ?? null, error: a.error ?? null }), reject).then(resolve, reject);
        },
      };
      return builder;
    }
  }
  return { db: db as unknown as SupabaseClient, calls };
}

const filter = (call: Call, column: string) => call.filters.find(([c]) => c === column);
const tenantFilter = (call: Call) => expect(filter(call, "tenant_id"), `${call.table} filters by tenant`).toEqual(["tenant_id", "eq", T]);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getMessage", () => {
  const row = { id: MSG, conversation_id: CONV, direction: "in", sender: "customer", kind: "text", created_at: "2026-10-08T10:00:00+00:00" };

  it("reads one message by its id, only if it is this business's and this conversation's", async () => {
    const { db, calls } = fakeDb(() => ({ data: row }));
    expect(await createPipelineStore(db).getMessage(T, CONV, MSG)).toEqual({ id: MSG, direction: "in", sender: "customer", kind: "text", createdAt: "2026-10-08T10:00:00.000Z" });
    expect(calls[0]).toMatchObject({ table: "messages", terminal: "maybeSingle" });
    tenantFilter(calls[0]);
    expect(filter(calls[0], "conversation_id")).toEqual(["conversation_id", "eq", CONV]);
    expect(filter(calls[0], "id")).toEqual(["id", "eq", MSG]);
  });

  it("answers null when there is none, and never asks for the body, which a step result must not carry", async () => {
    const { db, calls } = fakeDb(() => ({ data: null }));
    expect(await createPipelineStore(db).getMessage(T, CONV, MSG)).toBeNull();
    expect(calls[0].returning).not.toMatch(/body|media|meta/);
  });

  it("refuses a row of a kind or direction it does not know", async () => {
    const { db } = fakeDb(() => ({ data: { ...row, direction: "sideways" } }));
    await expect(createPipelineStore(db).getMessage(T, CONV, MSG)).rejects.toThrow();
  });
});

describe("getConversation", () => {
  it("reads the conversation of the business by id", async () => {
    const { db, calls } = fakeDb(() => ({ data: { id: CONV, contact_id: CONTACT, mode: "ai" } }));
    expect(await createPipelineStore(db).getConversation(T, CONV)).toEqual({ id: CONV, contactId: CONTACT, mode: "ai" });
    expect(calls[0].returning).toBe("id, contact_id, mode"); // only what the pipeline uses
    tenantFilter(calls[0]);
    expect(filter(calls[0], "id")).toEqual(["id", "eq", CONV]);
  });

  it("answers null when it is not the business's", async () => {
    const { db } = fakeDb(() => ({ data: null }));
    expect(await createPipelineStore(db).getConversation(T, CONV)).toBeNull();
  });
});

describe("getContact", () => {
  it("reads the language and whether they opted out, and never the phone number or the name", async () => {
    const { db, calls } = fakeDb(() => ({ data: { id: CONTACT, language: "ta-en", opted_out_at: null, consent_at: null } }));
    expect(await createPipelineStore(db).getContact(T, CONTACT)).toEqual({ id: CONTACT, language: "ta-en", optedOut: false, consentAt: null });
    tenantFilter(calls[0]);
    expect(calls[0].returning).not.toMatch(/phone|name/);
  });

  it("reports an opt-out", async () => {
    const { db } = fakeDb(() => ({ data: { id: CONTACT, language: null, opted_out_at: "2026-10-01T00:00:00Z", consent_at: null } }));
    expect((await createPipelineStore(db).getContact(T, CONTACT))?.optedOut).toBe(true);
  });
});

describe("getTenant", () => {
  it("reads the business by its id: the table's own id is the tenant", async () => {
    const { db, calls } = fakeDb(() => ({ data: { id: T, vertical: "pack-a", vertical_version: 1 } }));
    expect(await createPipelineStore(db).getTenant(T)).toEqual({ id: T, vertical: "pack-a", verticalVersion: 1 });
    expect(calls[0].returning).toBe("id, vertical, vertical_version"); // not the business's name or anything else
    expect(filter(calls[0], "id")).toEqual(["id", "eq", T]);
  });
});

describe("isAnswered", () => {
  it("looks for the audit row that says the message was answered, for this business, written after the message", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: 7 }] }));
    expect(await createPipelineStore(db).isAnswered(T, MSG, "2026-10-08T10:00:00.000Z")).toBe(true);
    tenantFilter(calls[0]);
    expect(calls[0].table).toBe("audit_logs");
    expect(filter(calls[0], "action")).toEqual(["action", "eq", "message.answered"]);
    expect(filter(calls[0], "entity_id")).toEqual(["entity_id", "eq", MSG]);
    // our clock against Meta's: a day of slack below the message's time, which also keeps the lookup on the index (tenant_id, created_at)
    expect(filter(calls[0], "created_at")).toEqual(["created_at", "gte", "2026-10-07T10:00:00.000Z"]);
    expect(calls[0].limit).toBe(1);
  });

  it("is false when there is none", async () => {
    const { db } = fakeDb(() => ({ data: [] }));
    expect(await createPipelineStore(db).isAnswered(T, MSG, "2026-10-08T10:00:00.000Z")).toBe(false);
  });
});

describe("findOrCreateOpenLead", () => {
  it("reuses the oldest open lead of the contact: any stage except won and lost", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: LEAD, stage: "engaged" }] }));
    expect(await createPipelineStore(db).findOrCreateOpenLead(T, CONTACT)).toEqual({ id: LEAD, stage: "engaged", created: false });
    expect(calls).toHaveLength(1);
    tenantFilter(calls[0]);
    expect(filter(calls[0], "contact_id")).toEqual(["contact_id", "eq", CONTACT]);
    expect(filter(calls[0], "stage")).toEqual(["stage", "not.in", "(won,lost)"]);
    expect(calls[0].order).toEqual(["created_at", true]);
    expect(calls[0].limit).toBe(1);
  });

  it("makes a new lead for the business and contact when there is no open one", async () => {
    const { db, calls } = fakeDb((call) => (call.op === "insert" ? { data: { id: LEAD, stage: "new" } } : { data: [] }));
    expect(await createPipelineStore(db).findOrCreateOpenLead(T, CONTACT)).toEqual({ id: LEAD, stage: "new", created: true });
    expect(calls.map((c) => c.op)).toEqual(["select", "insert"]);
    expect(calls[1].payload).toEqual({ tenant_id: T, contact_id: CONTACT });
  });
});

describe("recentUnanswered", () => {
  // the database answers newest first, as asked
  const newestFirst = [{ id: "m3", kind: "text" }, { id: "m2", kind: "image" }, { id: "m1", kind: null }];

  it("lists the customer's recent messages of the conversation that have not been answered, oldest first, with their kinds and no text", async () => {
    const { db, calls } = fakeDb((call) => (call.table === "messages" ? { data: newestFirst } : { data: [{ entity_id: "m2" }] }));
    expect(await createPipelineStore(db).recentUnanswered(T, CONV, "2026-10-08T09:59:50.000Z")).toEqual([
      { id: "m1", kind: null },
      { id: "m3", kind: "text" },
    ]);
    const [read, audit] = calls;
    expect(read.returning).toBe("id, kind");
    tenantFilter(read);
    expect(filter(read, "conversation_id")).toEqual(["conversation_id", "eq", CONV]);
    expect(filter(read, "direction")).toEqual(["direction", "eq", "in"]);
    expect(filter(read, "sender")).toEqual(["sender", "eq", "customer"]);
    expect(filter(read, "created_at")).toEqual(["created_at", "gte", "2026-10-08T09:59:50.000Z"]);
    tenantFilter(audit);
    expect(filter(audit, "entity_id")).toEqual(["entity_id", "in", ["m1", "m2", "m3"]]);
    expect(filter(audit, "action")).toEqual(["action", "eq", "message.answered"]);
  });

  it("takes the newest ten, not the oldest: if there are more, the latest are the ones to answer", async () => {
    const { db, calls } = fakeDb((call) => (call.table === "messages" ? { data: newestFirst } : { data: [] }));
    await createPipelineStore(db).recentUnanswered(T, CONV, "2026-10-08T09:59:50.000Z");
    expect(calls[0].order).toEqual(["created_at", false]);
    expect(calls[0].limit).toBe(10);
  });

  it("looks for the answered rows only from a day before the batch's start, so it never reads the business's whole audit log", async () => {
    const { db, calls } = fakeDb((call) => (call.table === "messages" ? { data: newestFirst } : { data: [] }));
    await createPipelineStore(db).recentUnanswered(T, CONV, "2026-10-08T09:59:50.000Z");
    expect(filter(calls[1], "created_at")).toEqual(["created_at", "gte", "2026-10-07T09:59:50.000Z"]);
  });

  it("asks nothing more when there are no messages", async () => {
    const { db, calls } = fakeDb(() => ({ data: [] }));
    expect(await createPipelineStore(db).recentUnanswered(T, CONV, "2026-10-08T09:59:50.000Z")).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("failures", () => {
  const failing = (code: string | undefined) => fakeDb(() => ({ error: { code, message: "secret detail 9812345621" } })).db;

  it.each(["08006", "08001", "53300", "57P01", "57014", "40001", "PGRST002", "", undefined])(
    "the Postgres code %s (the database unreachable or busy) is an ordinary error, which Inngest retries",
    async (code) => {
      const error = await createPipelineStore(failing(code)).getContact(T, CONTACT).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).not.toBeInstanceOf(NonRetriableError);
    },
  );

  it.each(["42501", "42P01", "22P02", "23505", "PGRST301", "P0001"])("the Postgres code %s (a refusal that waiting cannot fix) is not retried, and says nothing of what the database said", async (code) => {
    const error = (await createPipelineStore(failing(code)).getContact(T, CONTACT).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(NonRetriableError);
    expect(error.message).not.toMatch(/secret|9812345621/);
  });

  it("a row that is not the shape expected is not retried, and nothing of it is quoted", async () => {
    const { db } = fakeDb(() => ({ data: { id: CONTACT, language: 5, opted_out_at: "9812345621 secret" } }));
    const error = (await createPipelineStore(db).getContact(T, CONTACT).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(NonRetriableError);
    expect(error.message).not.toMatch(/secret|9812345621/);
    expect(vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n")).not.toMatch(/secret|9812345621/);
  });

  it("are fixed words with the Postgres code in the log only, never the database's text", async () => {
    const { db } = fakeDb(() => ({ error: { code: "42501", message: 'permission denied for table messages (row: "call me on 9812345621")' } }));
    const error = (await createPipelineStore(db).getMessage(T, CONV, MSG).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toMatch(/permission|9812345621|messages/);
    const logged = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("42501");
    expect(logged).not.toMatch(/9812345621|permission/);
  });

  it("every call can be cancelled, and one that never answers ends", async () => {
    let seen: AbortSignal | undefined;
    const { db } = fakeDb((call) => {
      seen = call.signal;
      return new Promise<never>(() => undefined);
    });
    const error = (await createPipelineStore(db, { timeoutMs: 20 }).getContact(T, CONTACT).catch((e: unknown) => e)) as AppError;
    expect(error.code).toBe("upstream_failed");
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(true);
  });
});

// --- what step 4 (understanding the message) needs ----------------------------------------------------------

describe("getPackOverrides", () => {
  it("reads the business's pack overrides by the business's own id", async () => {
    const { db, calls } = fakeDb(() => ({ data: { pack_overrides: { labels: { budget: "Your budget" } } } }));
    expect(await createPipelineStore(db).getPackOverrides(T)).toEqual({ labels: { budget: "Your budget" } });
    expect(calls[0].returning).toBe("pack_overrides");
    expect(filter(calls[0], "id")).toEqual(["id", "eq", T]);
  });

  it("is an empty object when there is no such business or none set", async () => {
    expect(await createPipelineStore(fakeDb(() => ({ data: null })).db).getPackOverrides(T)).toEqual({});
    expect(await createPipelineStore(fakeDb(() => ({ data: { pack_overrides: null } })).db).getPackOverrides(T)).toEqual({});
  });
});

describe("getLead", () => {
  it("reads the lead's stage and answers, only for this business", async () => {
    const { db, calls } = fakeDb(() => ({ data: { id: LEAD, stage: "new", fields: { budget: "80L" } } }));
    expect(await createPipelineStore(db).getLead(T, LEAD)).toEqual({ id: LEAD, stage: "new", fields: { budget: "80L" } });
    tenantFilter(calls[0]);
    expect(filter(calls[0], "id")).toEqual(["id", "eq", LEAD]);
  });

  it("answers null when it is not the business's, and treats a fields column that is not an object as empty", async () => {
    expect(await createPipelineStore(fakeDb(() => ({ data: null })).db).getLead(T, LEAD)).toBeNull();
    expect((await createPipelineStore(fakeDb(() => ({ data: { id: LEAD, stage: "new", fields: [1] } })).db).getLead(T, LEAD))?.fields).toEqual({});
  });
});

describe("mergeLeadFields", () => {
  it("merges the patch into the lead's answers in one database call, naming the business", async () => {
    const { db, calls } = fakeDb(() => ({ data: true }));
    expect(await createPipelineStore(db).mergeLeadFields(T, LEAD, { budget: "80L", location: "OMR" }, true)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "rpc", fn: "merge_lead_fields", args: { p_tenant_id: T, p_lead_id: LEAD, p_patch: { budget: "80L", location: "OMR" }, p_engage: true } });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("says false when the lead is not this business's", async () => {
    const { db } = fakeDb(() => ({ data: false }));
    expect(await createPipelineStore(db).mergeLeadFields(T, LEAD, {}, false)).toBe(false);
  });

  it("fails with fixed words, retried for a database that is down and not for a refused statement", async () => {
    await expect(createPipelineStore(fakeDb(() => ({ error: { code: "08006", message: "secret detail" } })).db).mergeLeadFields(T, LEAD, {}, true)).rejects.toBeInstanceOf(AppError);
    await expect(createPipelineStore(fakeDb(() => ({ error: { code: "P0001", message: "secret detail" } })).db).mergeLeadFields(T, LEAD, {}, true)).rejects.toBeInstanceOf(NonRetriableError);
  });
});

describe("getBatchTexts", () => {
  it("tells which button or list row a tap was (the inbound message's meta.buttonId), and nothing else of the meta", async () => {
    const { db } = fakeDb(() => ({ data: [{ id: "m1", body: "Talk to the team", created_at: "2026-10-08T10:00:00+00:00", meta: { buttonId: "exit:talk", other: "x" } }, { id: "m2", body: "hi", created_at: "2026-10-08T10:00:02+00:00", meta: { buttonId: 5 } }] }));
    expect(await createPipelineStore(db).getBatchTexts(T, CONV, ["m1", "m2"])).toEqual([
      { id: "m1", body: "Talk to the team", createdAt: "2026-10-08T10:00:00.000Z", buttonId: "exit:talk", kind: null },
      { id: "m2", body: "hi", createdAt: "2026-10-08T10:00:02.000Z", buttonId: null, kind: null },
    ]);
  });

  it("reads the text of these customer messages of this conversation, oldest first", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: "m1", body: "hi", created_at: "2026-10-08T10:00:00+00:00" }, { id: "m2", body: null, created_at: "2026-10-08T10:00:02+00:00" }] }));
    expect(await createPipelineStore(db).getBatchTexts(T, CONV, ["m1", "m2"])).toEqual([
      { id: "m1", body: "hi", createdAt: "2026-10-08T10:00:00.000Z", buttonId: null, kind: null },
      { id: "m2", body: null, createdAt: "2026-10-08T10:00:02.000Z", buttonId: null, kind: null },
    ]);
    tenantFilter(calls[0]);
    expect(filter(calls[0], "conversation_id")).toEqual(["conversation_id", "eq", CONV]);
    expect(filter(calls[0], "id")).toEqual(["id", "in", ["m1", "m2"]]);
    expect(filter(calls[0], "sender")).toEqual(["sender", "eq", "customer"]);
    expect(calls[0].order).toEqual(["created_at", true]);
  });

  it("tells the kind of each message (a voice note is an audio message with no words), and null for a row from before the column existed", async () => {
    const { db } = fakeDb(() => ({ data: [{ id: "m1", body: null, created_at: "2026-10-08T10:00:00+00:00", kind: "audio" }, { id: "m2", body: "hi", created_at: "2026-10-08T10:00:02+00:00", kind: "text" }] }));
    const texts = await createPipelineStore(db).getBatchTexts(T, CONV, ["m1", "m2"]);
    expect(texts.map((t) => t.kind)).toEqual(["audio", "text"]);
  });

  it("asks nothing for no ids", async () => {
    const { db, calls } = fakeDb(() => ({ data: [] }));
    expect(await createPipelineStore(db).getBatchTexts(T, CONV, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("getHistory", () => {
  it("reads the last few messages before a time, oldest first, leaving out system notes and messages with no text", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ sender: "ai", body: "Hello" }, { sender: "customer", body: "price?" }] }));
    expect(await createPipelineStore(db).getHistory(T, CONV, "2026-10-08T10:00:00.000Z", 4)).toEqual([
      { sender: "customer", body: "price?" },
      { sender: "ai", body: "Hello" },
    ]);
    tenantFilter(calls[0]);
    expect(filter(calls[0], "conversation_id")).toEqual(["conversation_id", "eq", CONV]);
    expect(filter(calls[0], "created_at")).toEqual(["created_at", "lt", "2026-10-08T10:00:00.000Z"]);
    expect(filter(calls[0], "sender")).toEqual(["sender", "in", ["customer", "ai", "staff"]]);
    expect(filter(calls[0], "body")).toEqual(["body", "not.is", null]); // the limit counts messages with text only
    expect(calls[0].order).toEqual(["created_at", false]); // the latest, then put back in order
    expect(calls[0].limit).toBe(4);
  });
});

describe("saveAgentMeta and getAgentMeta", () => {
  const read = (meta: unknown) => (call: Call) => (call.op === "select" ? { data: { meta } } : {});

  it("merges what the turn worked out into the message's meta under `agent` in one database call, naming business, conversation and message", async () => {
    const { db, calls } = fakeDb(() => ({ data: true }));
    expect(await createPipelineStore(db).saveAgentMeta(T, CONV, MSG, { extraction: { intent: "question" } })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      op: "rpc",
      fn: "merge_message_agent_meta",
      args: { p_tenant_id: T, p_conversation_id: CONV, p_message_id: MSG, p_agent: { extraction: { intent: "question" } } },
    });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("says false when the message is not this business's and conversation's", async () => {
    const { db } = fakeDb(() => ({ data: false }));
    expect(await createPipelineStore(db).saveAgentMeta(T, CONV, MSG, { a: 1 })).toBe(false);
  });

  it("fails with fixed words, retried for a database that is down and not for a refused statement", async () => {
    await expect(createPipelineStore(fakeDb(() => ({ error: { code: "57P01", message: "secret detail" } })).db).saveAgentMeta(T, CONV, MSG, { a: 1 })).rejects.toBeInstanceOf(AppError);
    await expect(createPipelineStore(fakeDb(() => ({ error: { code: "P0001", message: "secret detail" } })).db).saveAgentMeta(T, CONV, MSG, { a: 1 })).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("reads it back", async () => {
    expect(await createPipelineStore(fakeDb(read({ agent: { extraction: { intent: "question" } } })).db).getAgentMeta(T, CONV, MSG)).toEqual({ extraction: { intent: "question" } });
    expect(await createPipelineStore(fakeDb(read({})).db).getAgentMeta(T, CONV, MSG)).toBeNull();
    expect(await createPipelineStore(fakeDb(() => ({ data: null })).db).getAgentMeta(T, CONV, MSG)).toBeNull();
  });
});

describe("the contact's consent", () => {
  it("getContact says when the notice was first shown, or null", async () => {
    const { db, calls } = fakeDb(() => ({ data: { id: CONTACT, language: "ta", opted_out_at: null, consent_at: "2026-10-09T10:00:00+00:00" } }));
    expect(await createPipelineStore(db).getContact(T, CONTACT)).toEqual({ id: CONTACT, language: "ta", optedOut: false, consentAt: "2026-10-09T10:00:00+00:00" });
    expect(calls[0].returning).toContain("consent_at");
    expect(await createPipelineStore(fakeDb(() => ({ data: { id: CONTACT, language: null, opted_out_at: "2026-10-09T10:00:00+00:00", consent_at: null } })).db).getContact(T, CONTACT)).toEqual({ id: CONTACT, language: null, optedOut: true, consentAt: null });
  });

  it("recordNoticeShown calls record_notice_shown for this business and contact, and says whether it recorded", async () => {
    const { db, calls } = fakeDb(() => ({ data: true }));
    expect(await createPipelineStore(db).recordNoticeShown(T, CONTACT, MSG)).toBe(true);
    expect(calls[0]).toMatchObject({ op: "rpc", fn: "record_notice_shown", args: { p_tenant_id: T, p_contact_id: CONTACT, p_message_id: MSG } });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(await createPipelineStore(fakeDb(() => ({ data: false })).db).recordNoticeShown(T, CONTACT, null)).toBe(false);
  });

  it("recordOptOut calls record_opt_out with the source and the message", async () => {
    const { db, calls } = fakeDb(() => ({ data: true }));
    expect(await createPipelineStore(db).recordOptOut(T, CONTACT, "stop_keyword", MSG)).toBe(true);
    expect(calls[0]).toMatchObject({ op: "rpc", fn: "record_opt_out", args: { p_tenant_id: T, p_contact_id: CONTACT, p_source: "stop_keyword", p_message_id: MSG } });
    expect(await createPipelineStore(fakeDb(() => ({ data: false })).db).recordOptOut(T, CONTACT, "stop_keyword", null)).toBe(false);
  });

  it("both fail in fixed words: retried for a database that is down, not for a refused input", async () => {
    for (const call of [
      (s: ReturnType<typeof createPipelineStore>) => s.recordNoticeShown(T, CONTACT, null),
      (s: ReturnType<typeof createPipelineStore>) => s.recordOptOut(T, CONTACT, "stop_keyword", null),
    ]) {
      await expect(call(createPipelineStore(fakeDb(() => ({ error: { code: "08006", message: "secret" } })).db))).rejects.toBeInstanceOf(AppError);
      await expect(call(createPipelineStore(fakeDb(() => ({ error: { code: "P0001", message: "secret" } })).db))).rejects.toBeInstanceOf(NonRetriableError);
    }
  });
});

describe("getTenantReplyInfo", () => {
  it("reads the business's name and agent settings by its own id", async () => {
    const { db, calls } = fakeDb(() => ({ data: { name: "Skyline Homes", agent_settings: { persona: "Maya" } } }));
    expect(await createPipelineStore(db).getTenantReplyInfo(T)).toEqual({ name: "Skyline Homes", agentSettings: { persona: "Maya" } });
    expect(calls[0]).toMatchObject({ table: "tenants", terminal: "maybeSingle" });
    expect(filter(calls[0], "id")).toEqual(["id", "eq", T]);
  });

  it("answers null when the business is gone", async () => {
    expect(await createPipelineStore(fakeDb(() => ({ data: null })).db).getTenantReplyInfo(T)).toBeNull();
  });
});

describe("getPreviousMisses", () => {
  const rows = (...metas: unknown[]) => ({ data: metas.map((meta) => ({ meta })) });

  it("reads the newest earlier customer messages of this chat, newest first, for this business", async () => {
    const { db, calls } = fakeDb(() => rows({}));
    await createPipelineStore(db).getPreviousMisses(T, CONV, "2026-10-08T10:00:00.000Z");
    tenantFilter(calls[0]);
    expect(filter(calls[0], "conversation_id")).toEqual(["conversation_id", "eq", CONV]);
    expect(filter(calls[0], "sender")).toEqual(["sender", "eq", "customer"]);
    expect(filter(calls[0], "created_at")).toEqual(["created_at", "lt", "2026-10-08T10:00:00.000Z"]);
    expect(calls[0].order).toEqual(["created_at", false]);
    expect(calls[0].limit).toBe(20);
  });

  it("is the count the latest turn left, skipping messages no turn wrote on", async () => {
    const { db } = fakeDb(() => rows({ buttonId: "x" }, { agent: { extraction: {} } }, { agent: { kbMisses: 1 } }, { agent: { kbMisses: 5 } }));
    expect(await createPipelineStore(db).getPreviousMisses(T, CONV, "2026-10-08T10:00:00.000Z")).toBe(1);
  });

  it("is 0 for a chat with no earlier turn, and for a count that is not a whole number", async () => {
    expect(await createPipelineStore(fakeDb(() => rows({}, null)).db).getPreviousMisses(T, CONV, "2026-10-08T10:00:00.000Z")).toBe(0);
    expect(await createPipelineStore(fakeDb(() => rows({ agent: { kbMisses: -1 } }, { agent: { kbMisses: 1.5 } }, { agent: { kbMisses: "2" } })).db).getPreviousMisses(T, CONV, "2026-10-08T10:00:00.000Z")).toBe(0);
    expect(await createPipelineStore(fakeDb(() => ({ data: [] })).db).getPreviousMisses(T, CONV, "2026-10-08T10:00:00.000Z")).toBe(0);
  });
});

describe("recordKbGap", () => {
  it("calls record_kb_gap for this business with the contact, no summary, and gives back the gap and its count", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ gap_id: "g1", asked_count: 3, status: "open", created: false }] }));
    expect(await createPipelineStore(db).recordKbGap(T, { question: "Parking?", questionNorm: "parking", contactId: CONTACT })).toEqual({ gapId: "g1", askedCount: 3 });
    expect(calls[0]).toMatchObject({ op: "rpc", fn: "record_kb_gap", args: { p_tenant_id: T, p_question: "Parking?", p_question_norm: "parking", p_summary: null, p_contact_id: CONTACT } });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("is retried for a database that is down, and not for a refused input", async () => {
    await expect(createPipelineStore(fakeDb(() => ({ error: { code: "08006", message: "x" } })).db).recordKbGap(T, { question: "q", questionNorm: "q", contactId: CONTACT })).rejects.toBeInstanceOf(AppError);
    await expect(createPipelineStore(fakeDb(() => ({ error: { code: "P0001", message: "secret" } })).db).recordKbGap(T, { question: "q", questionNorm: "q", contactId: CONTACT })).rejects.toBeInstanceOf(NonRetriableError);
  });
});

describe("openHandoff", () => {
  it("gives back the chat's open handoff and makes none when there is one", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: "h1" }] }));
    expect(await createPipelineStore(db).openHandoff(T, CONV, "kb_gap", "normal")).toEqual({ id: "h1", created: false });
    expect(calls).toHaveLength(1);
    tenantFilter(calls[0]);
    expect(filter(calls[0], "conversation_id")).toEqual(["conversation_id", "eq", CONV]);
    expect(filter(calls[0], "resolved_at")).toEqual(["resolved_at", "is", null]);
  });

  it("opens one for this business and chat when there is none", async () => {
    const { db, calls } = fakeDb((call) => (call.op === "insert" ? { data: { id: "h2" } } : { data: [] }));
    expect(await createPipelineStore(db).openHandoff(T, CONV, "credits_exhausted", "high")).toEqual({ id: "h2", created: true });
    expect(calls[1]).toMatchObject({ table: "handoffs", op: "insert", payload: { tenant_id: T, conversation_id: CONV, trigger: "credits_exhausted", priority: "high" }, terminal: "single" });
  });
});

describe("setConversationMode", () => {
  it("switches only a chat the AI has, for this business, and says whether it did", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: CONV }] }));
    expect(await createPipelineStore(db).setConversationMode(T, CONV, "human")).toBe(true);
    expect(calls[0]).toMatchObject({ table: "conversations", op: "update", payload: { mode: "human" } });
    tenantFilter(calls[0]);
    expect(filter(calls[0], "id")).toEqual(["id", "eq", CONV]);
    expect(filter(calls[0], "mode")).toEqual(["mode", "eq", "ai"]);
    expect(await createPipelineStore(fakeDb(() => ({ data: [] })).db).setConversationMode(T, CONV, "human")).toBe(false);
  });
});

describe("getPreviousPlanCase", () => {
  const rows = (...metas: unknown[]) => ({ data: metas.map((meta) => ({ meta })) });

  it("reads the newest earlier customer messages of this chat, for this business", async () => {
    const { db, calls } = fakeDb(() => rows({}));
    await createPipelineStore(db).getPreviousPlanCase(T, CONV, "2026-10-08T10:00:00.000Z");
    tenantFilter(calls[0]);
    expect(filter(calls[0], "conversation_id")).toEqual(["conversation_id", "eq", CONV]);
    expect(filter(calls[0], "sender")).toEqual(["sender", "eq", "customer"]);
    expect(filter(calls[0], "created_at")).toEqual(["created_at", "lt", "2026-10-08T10:00:00.000Z"]);
    expect(calls[0].limit).toBe(20);
  });

  it("is the case the latest turn kept, skipping messages no turn wrote on, and null when there is none", async () => {
    expect(await createPipelineStore(fakeDb(() => rows({ buttonId: "x" }, { agent: { planCase: "exit_unclear" } }, { agent: { planCase: "answered_from_kb" } })).db).getPreviousPlanCase(T, CONV, "2026-10-08T10:00:00.000Z")).toBe("exit_unclear");
    expect(await createPipelineStore(fakeDb(() => rows({}, null, { agent: { planCase: 3 } })).db).getPreviousPlanCase(T, CONV, "2026-10-08T10:00:00.000Z")).toBeNull();
  });
});

describe("getPreviousOffer", () => {
  const rows = (...metas: unknown[]) => ({ data: metas.map((meta) => ({ meta })) });
  const SLOT = { start: "2026-10-13T04:30:00.000Z", end: "2026-10-13T05:30:00.000Z", resourceId: "20000000-0000-0000-0000-000000000002", serviceId: "10000000-0000-0000-0000-000000000001", label: "Tue 13 Oct, 10:00 am" };
  const offer = { slots: [SLOT], at: "2026-10-10T04:30:00.000Z" };

  it("reads the newest earlier customer messages of this chat, for this business", async () => {
    const { db, calls } = fakeDb(() => rows({}));
    await createPipelineStore(db).getPreviousOffer(T, CONV, "2026-10-08T10:00:00.000Z");
    tenantFilter(calls[0]);
    expect(filter(calls[0], "conversation_id")).toEqual(["conversation_id", "eq", CONV]);
    expect(filter(calls[0], "sender")).toEqual(["sender", "eq", "customer"]);
    expect(filter(calls[0], "created_at")).toEqual(["created_at", "lt", "2026-10-08T10:00:00.000Z"]);
    expect(calls[0].limit).toBe(20);
  });

  it("is the offer the latest turn that spoke of one left, skipping messages that say nothing about it", async () => {
    expect(await createPipelineStore(fakeDb(() => rows({ agent: { planCase: "kb_miss" } }, { agent: { offer } }, { agent: { offer: null } })).db).getPreviousOffer(T, CONV, "2026-10-09T00:00:00.000Z")).toEqual(offer);
  });

  it("is no offer when the newest turn ended it, even if an older one made one", async () => {
    expect(await createPipelineStore(fakeDb(() => rows({ agent: { offer: null } }, { agent: { offer } })).db).getPreviousOffer(T, CONV, "2026-10-09T00:00:00.000Z")).toBeNull();
  });

  it("is no offer when there is none, or what is kept cannot be read", async () => {
    expect(await createPipelineStore(fakeDb(() => rows({}, null, { agent: { planCase: "x" } })).db).getPreviousOffer(T, CONV, "2026-10-09T00:00:00.000Z")).toBeNull();
    expect(await createPipelineStore(fakeDb(() => rows({ agent: { offer: { slots: "x" } } }, { agent: { offer } })).db).getPreviousOffer(T, CONV, "2026-10-09T00:00:00.000Z")).toBeNull();
  });
});

describe("hasHotLeadAlert", () => {
  it("looks for the audit row that says staff were told, for this business and this lead", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: 1 }] }));
    expect(await createPipelineStore(db).hasHotLeadAlert(T, LEAD)).toBe(true);
    expect(calls[0].table).toBe("audit_logs");
    tenantFilter(calls[0]);
    expect(filter(calls[0], "action")).toEqual(["action", "eq", "lead.hot_alerted"]);
    expect(filter(calls[0], "entity_id")).toEqual(["entity_id", "eq", LEAD]);
  });

  it("is false when there is none", async () => {
    expect(await createPipelineStore(fakeDb(() => ({ data: [] })).db).hasHotLeadAlert(T, LEAD)).toBe(false);
  });
});

describe("saveLeadScore", () => {
  it("writes the score and temperature of an open lead of this business, by id", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: LEAD }] }));
    expect(await createPipelineStore(db).saveLeadScore(T, LEAD, { score: 75, temperature: "hot" })).toBe(true);
    expect(calls[0].table).toBe("leads");
    expect(calls[0].op).toBe("update");
    expect(calls[0].payload).toEqual({ score: 75, temperature: "hot" });
    tenantFilter(calls[0]);
    expect(filter(calls[0], "id")).toEqual(["id", "eq", LEAD]);
    expect(filter(calls[0], "stage")).toEqual(["stage", "in", ["new", "engaged", "qualified", "nurture"]]);
  });

  it("is false when nothing changed (a booked, won or lost lead keeps its score)", async () => {
    expect(await createPipelineStore(fakeDb(() => ({ data: [] })).db).saveLeadScore(T, LEAD, { score: 0, temperature: "cold" })).toBe(false);
  });
});

describe("markLeadLost", () => {
  it("moves only an open lead of this business, by id: a booked, visited, won or lost one is left alone", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: LEAD }] }));
    expect(await createPipelineStore(db).markLeadLost(T, LEAD)).toBe(true);
    expect(calls[0].table).toBe("leads");
    expect(calls[0].op).toBe("update");
    expect(calls[0].payload).toEqual({ stage: "lost" });
    tenantFilter(calls[0]);
    expect(filter(calls[0], "id")).toEqual(["id", "eq", LEAD]);
    expect(filter(calls[0], "stage")).toEqual(["stage", "in", ["new", "engaged", "qualified", "nurture"]]);
  });

  it("is false when nothing changed", async () => {
    expect(await createPipelineStore(fakeDb(() => ({ data: [] })).db).markLeadLost(T, LEAD)).toBe(false);
  });
});

describe("getPreviousCoverage", () => {
  const rows = (...metas: unknown[]) => ({ data: metas.map((meta) => ({ meta })) });
  const options = { area: "adyar", stage: "options" };

  it("reads the newest earlier customer messages of this chat, for this business", async () => {
    const { db, calls } = fakeDb(() => rows({}));
    await createPipelineStore(db).getPreviousCoverage(T, CONV, "2026-10-08T10:00:00.000Z");
    tenantFilter(calls[0]);
    expect(filter(calls[0], "conversation_id")).toEqual(["conversation_id", "eq", CONV]);
    expect(filter(calls[0], "sender")).toEqual(["sender", "eq", "customer"]);
    expect(filter(calls[0], "created_at")).toEqual(["created_at", "lt", "2026-10-08T10:00:00.000Z"]);
    expect(calls[0].limit).toBe(20);
  });

  it("is what the latest turn that spoke of an unserved area left, skipping messages that say nothing about it", async () => {
    const store = createPipelineStore(fakeDb(() => rows({ agent: { planCase: "kb_miss" } }, { agent: { coverage: options } }, { agent: { coverage: { area: "mylapore", stage: "options" } } })).db);
    expect(await store.getPreviousCoverage(T, CONV, "2026-10-09T00:00:00.000Z")).toEqual(options);
  });

  it("is nothing when the newest turn that spoke of it ended it, even if an older one set it", async () => {
    expect(await createPipelineStore(fakeDb(() => rows({ agent: { coverage: null } }, { agent: { coverage: options } })).db).getPreviousCoverage(T, CONV, "2026-10-09T00:00:00.000Z")).toBeNull();
  });

  it("is nothing for a value it cannot read, and nothing when there is none", async () => {
    expect(await createPipelineStore(fakeDb(() => rows({ agent: { coverage: { area: "adyar", stage: "later" } } }, { agent: { coverage: options } })).db).getPreviousCoverage(T, CONV, "2026-10-09T00:00:00.000Z")).toBeNull();
    expect(await createPipelineStore(fakeDb(() => rows({}, null, { agent: { planCase: "x" } })).db).getPreviousCoverage(T, CONV, "2026-10-09T00:00:00.000Z")).toBeNull();
  });
});

describe("recordedMessageIds", () => {
  const IDS = ["920a027e-6b11-50c5-847c-16d2b620a79e", "78e5eae4-3d34-557c-a246-fa8d874a460d"];

  it("reads only this business's and this chat's messages, by id", async () => {
    const { db, calls } = fakeDb(() => ({ data: [] }));
    await createPipelineStore(db).recordedMessageIds(T, CONV, IDS);
    expect(calls[0].table).toBe("messages");
    tenantFilter(calls[0]);
    expect(filter(calls[0], "conversation_id")).toEqual(["conversation_id", "eq", CONV]);
    expect(filter(calls[0], "id")).toEqual(["id", "in", IDS]);
  });

  it("is the ids that are there", async () => {
    const store = createPipelineStore(fakeDb(() => ({ data: [{ id: IDS[1] }] })).db);
    expect(await store.recordedMessageIds(T, CONV, IDS)).toEqual([IDS[1]]);
  });

  it("asks nothing for no ids", async () => {
    const { db, calls } = fakeDb(() => ({ data: [] }));
    expect(await createPipelineStore(db).recordedMessageIds(T, CONV, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("does not hide a database error", async () => {
    const store = createPipelineStore(fakeDb(() => ({ error: { message: "boom", code: "XX000" } })).db);
    await expect(store.recordedMessageIds(T, CONV, IDS)).rejects.toThrow();
  });
});

describe("claimedMessageIds (notify_attempts, Dev 2's table, read only)", () => {
  const IDS = ["920a027e-6b11-50c5-847c-16d2b620a79e", "78e5eae4-3d34-557c-a246-fa8d874a460d"];

  it("reads only this business's claims that are still 'sending', by message id", async () => {
    const { db, calls } = fakeDb(() => ({ data: [] }));
    await createPipelineStore(db).claimedMessageIds(T, IDS);
    expect(calls[0].table).toBe("notify_attempts");
    tenantFilter(calls[0]);
    expect(filter(calls[0], "message_id")).toEqual(["message_id", "in", IDS]);
    expect(filter(calls[0], "status")).toEqual(["status", "eq", "sending"]);
  });

  it("is the message ids that are claimed", async () => {
    const store = createPipelineStore(fakeDb(() => ({ data: [{ message_id: IDS[0] }] })).db);
    expect(await store.claimedMessageIds(T, IDS)).toEqual([IDS[0]]);
  });

  it("asks nothing for no ids", async () => {
    const { db, calls } = fakeDb(() => ({ data: [] }));
    expect(await createPipelineStore(db).claimedMessageIds(T, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("does not hide a database error, and does not trust a row of the wrong shape", async () => {
    await expect(createPipelineStore(fakeDb(() => ({ error: { message: "boom", code: "XX000" } })).db).claimedMessageIds(T, IDS)).rejects.toThrow();
    await expect(createPipelineStore(fakeDb(() => ({ data: [{ message_id: 5 }] })).db).claimedMessageIds(T, IDS)).rejects.toThrow();
  });
});

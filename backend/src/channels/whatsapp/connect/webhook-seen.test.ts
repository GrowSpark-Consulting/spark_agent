import { beforeEach, describe, expect, it } from "vitest";
import { fakeTables } from "../../../test-support/fake-tables";
import { forgetNotedWebhooks, noteWebhookSeen, webhookWasSeen, WEBHOOK_SEEN_ACTION } from "./webhook-seen";

// Proof that a manual_byo connection's own app delivers signed webhooks: one audit row per connection, written the first time, never on every webhook.

const A = "e0000000-0000-4000-8000-00000000000a";
const B = "e0000000-0000-4000-8000-00000000000b";
const CONN = "d4000000-0000-4000-8000-0000000000a1";

beforeEach(() => forgetNotedWebhooks());

describe("a webhook was seen", () => {
  it("is not known before any webhook arrived, and is known after the first", async () => {
    const t = fakeTables({ audit_logs: [] });
    expect(await webhookWasSeen(t.db, A, CONN)).toBe(false);
    await noteWebhookSeen(A, CONN, t.db);
    expect(await webhookWasSeen(t.db, A, CONN)).toBe(true);
    expect(t.tables.audit_logs).toEqual([expect.objectContaining({ tenant_id: A, action: WEBHOOK_SEEN_ACTION, entity_id: CONN, actor: "system" })]);
  });

  it("writes one row however many webhooks come, and reads the log only once while the server runs", async () => {
    const t = fakeTables({ audit_logs: [] });
    for (let i = 0; i < 5; i++) await noteWebhookSeen(A, CONN, t.db);
    expect(t.tables.audit_logs).toHaveLength(1);
    expect(t.calls.filter((c) => c.op === "select")).toHaveLength(1);
  });

  it("does not write again after a restart when the row is already there", async () => {
    const t = fakeTables({ audit_logs: [{ id: "x", tenant_id: A, action: WEBHOOK_SEEN_ACTION, entity_id: CONN }] });
    await noteWebhookSeen(A, CONN, t.db);
    expect(t.tables.audit_logs).toHaveLength(1);
  });

  it("another business's row proves nothing", async () => {
    const t = fakeTables({ audit_logs: [{ id: "x", tenant_id: B, action: WEBHOOK_SEEN_ACTION, entity_id: CONN }] });
    expect(await webhookWasSeen(t.db, A, CONN)).toBe(false);
  });

  it("never throws, and tries again with the next webhook after a failure", async () => {
    const broken = fakeTables({ audit_logs: { error: { code: "XX000" } } });
    await expect(noteWebhookSeen(A, CONN, broken.db)).resolves.toBeUndefined();
    const t = fakeTables({ audit_logs: [] });
    await noteWebhookSeen(A, CONN, t.db);
    expect(t.tables.audit_logs).toHaveLength(1);
  });
});

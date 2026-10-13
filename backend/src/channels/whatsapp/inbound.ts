import { inngest } from "../../inngest/client";
import { serverEnv } from "../../lib/env";
import { AppError } from "../../lib/errors";
import { stripUnsafeCharacters } from "../../lib/text";
import { storeEchoedMessage, type EchoArgs, type EchoOutcome } from "./echo";
import * as db from "./inbound-db";
import { WebhookDbError, type ConnectionRow, type StoreInboundArgs } from "./inbound-db";
import { noteWebhookSeen } from "./connect/webhook-seen";
import { demoDb } from "./demo/db";
import { routeDemoMessage, type DemoDecision, type DemoMessage } from "./demo/route";
import { parseWebhook, type ParsedMessage } from "./parse";
import { verifySignature } from "./signature";
import { supabaseAdmin } from "../../lib/supabase-admin";

// POST /api/webhooks/whatsapp: Meta delivering messages and delivery statuses (docs/handover.md, "Message
// pipeline" and module 10, "Webhooks"). Order matters:
//   1. the signature, over the exact bytes received, before anything in the body is read or trusted;
//   2. the business, only from whatsapp_connections by phone number id (never from the payload);
//   3. store each message (idempotent on the wamid) and queue whatsapp/message.received with ids only.
// The answer is 200 once every item is stored and queued. A database or Inngest failure answers 500 so
// Meta retries; the dedupe makes the retry safe. Logs hold counts only: no numbers, names, text, message
// ids or secrets, and no database error text (it can contain values).
//
// A request can be signed two ways. With META_APP_SECRET (our own Meta app) it serves the methods listed
// below. Otherwise the signature is tried against the app secrets of the manual_byo connections for the phone
// numbers the (not yet trusted) body names; a match serves only those connections. A method we have not
// listed is not trusted by default, and a connection is never served on the other kind's signature.

const SIGNATURE_FORMAT = /^sha256=[0-9a-fA-F]{64}$/;
/** Connection methods whose webhooks come from our own Meta app, signed with META_APP_SECRET. */
const PLATFORM_SIGNED = new Set(["embedded_signup", "assisted", "platform"]);
const TAG = "[whatsapp-webhook]";

const unauthenticated = () => new AppError("unauthenticated", "The request could not be verified.");

/** Customer text with NUL, control characters and lone surrogates removed: one of them would fail the insert, and Meta would resend the batch. */
const clean = (text: string | undefined) => (text === undefined ? undefined : stripUnsafeCharacters(text));

function toStorable(parsed: ParsedMessage): Pick<StoreInboundArgs, "kind" | "body" | "media" | "meta"> {
  const msg = { ...parsed, text: clean(parsed.text) };
  switch (msg.type) {
    case "unsupported":
      return { kind: "unsupported", body: null, meta: { unsupportedType: msg.unsupportedType ?? "unknown" } };
    case "interactive":
      return { kind: "interactive", body: msg.text ?? null, meta: { buttonId: clean(msg.buttonId) } };
    case "image":
    case "audio":
    case "document":
      return { kind: msg.type, body: msg.text ?? null, media: msg.media && { id: stripUnsafeCharacters(msg.media.id), mime: stripUnsafeCharacters(msg.media.mime) }, meta: {} };
    default:
      return { kind: msg.type, body: msg.text ?? null, meta: {} };
  }
}

/**
 * What the handler talks to, so a test can replace it. The handler waits for these and for nothing else before it
 * answers: the database (store a message, apply a status or a template status, record a number's health) and the
 * queue (send the event). No model, embeddings or Meta call is ever awaited here.
 */
export interface WebhookDeps {
  findConnections: typeof db.findConnections;
  findConnectionsByWaba: typeof db.findConnectionsByWaba;
  findByoSecrets: typeof db.findByoSecrets;
  storeInboundMessage: typeof db.storeInboundMessage;
  applyMessageStatus: typeof db.applyMessageStatus;
  templateBelongsToTenant: typeof db.templateBelongsToTenant;
  setTemplateStatus: typeof db.setTemplateStatus;
  updateConnectionHealth: typeof db.updateConnectionHealth;
  /**
   * Keeps the owner's reply from the phone app as a staff message and, if the AI had the chat, switches it to a person (echo.ts). Optional so
   * that a caller built before coexistence still works: without it an echo is counted and skipped.
   */
  storeEchoedMessage?: (args: EchoArgs) => Promise<EchoOutcome>;
  sendEvent: (event: { id: string; name: string; data: Record<string, string> }) => Promise<unknown>;
  /**
   * A request signed with a manual_byo connection's own app secret named this connection: proof for its webhook check (connect/webhook-seen.ts).
   * Best effort, never awaited by the answer. Optional so that a caller built before it still works.
   */
  noteWebhookSeen?: (tenantId: string, connectionId: string) => Promise<void>;
  /**
   * The shared demo number (demo/route.ts): a customer's message on it belongs to the business its route code names, not to
   * the business that owns the number's connection row. Optional: without it (or when no demo number is set) every number
   * behaves as before.
   */
  demo?: { phoneNumberId: string; route: (message: DemoMessage) => Promise<DemoDecision> };
}

/** The demo number's id, if one is set. An invalid environment is reported by the handler itself, so here it just means none. */
function demoNumberId(): string | undefined {
  try {
    return serverEnv().WHATSAPP_DEMO_PHONE_NUMBER_ID;
  } catch {
    return undefined;
  }
}

// Looked up when called (not when the module loads), so a test that replaces inbound-db or the queue is honoured.
const realDeps = (): WebhookDeps => ({
  findConnections: db.findConnections,
  findConnectionsByWaba: db.findConnectionsByWaba,
  findByoSecrets: db.findByoSecrets,
  storeInboundMessage: db.storeInboundMessage,
  applyMessageStatus: db.applyMessageStatus,
  templateBelongsToTenant: db.templateBelongsToTenant,
  setTemplateStatus: db.setTemplateStatus,
  updateConnectionHealth: db.updateConnectionHealth,
  storeEchoedMessage: (args) => storeEchoedMessage(supabaseAdmin(), args),
  sendEvent: (event) => inngest.send(event),
  noteWebhookSeen: (tenantId, connectionId) => noteWebhookSeen(tenantId, connectionId),
  ...(demoNumberId() ? { demo: { phoneNumberId: demoNumberId() as string, route: (message: DemoMessage) => routeDemoMessage(message, demoDb()) } } : {}),
});

export async function handleWhatsAppWebhook(request: Request, deps: WebhookDeps = realDeps()): Promise<Response> {
  const signature = request.headers.get("x-hub-signature-256");
  if (signature === null || !SIGNATURE_FORMAT.test(signature)) throw unauthenticated();

  let appSecret: string | undefined;
  try {
    appSecret = serverEnv().META_APP_SECRET;
  } catch {
    console.error(`${TAG} environment invalid`);
    return Response.json({ error: { code: "internal", message: "Something went wrong on our side." } }, { status: 500 });
  }

  // The body is read once, as bytes, and verified before it is decoded.
  const raw = new Uint8Array(await request.arrayBuffer());
  const signedByPlatform = !!appSecret && verifySignature(raw, signature, appSecret);

  // Connections whose own app secret signed this request (manual_byo). Only tried when ours did not match.
  const byoVerified = new Set<string>();
  if (!signedByPlatform) {
    try {
      // The ids in a body that is not verified yet only choose which secrets to try.
      const candidates = parseWebhook(JSON.parse(new TextDecoder().decode(raw)));
      const phoneIds = [...new Set([...candidates.messages, ...candidates.statuses, ...candidates.echoes].map((item) => item.phoneNumberId))];
      for (const { connectionId, secret } of await deps.findByoSecrets(phoneIds)) {
        if (verifySignature(raw, signature, secret)) byoVerified.add(connectionId);
      }
    } catch (err) {
      if (err instanceof WebhookDbError) {
        console.error(`${TAG} secret lookup failed code=${err.code}`);
        return Response.json({ error: { code: "internal", message: "Something went wrong on our side." } }, { status: 500 });
      }
      // a body that is not JSON cannot name a connection; it falls through to the refusal below
    }
    if (byoVerified.size === 0) {
      if (!appSecret) {
        console.error(`${TAG} META_APP_SECRET is not set`);
        return Response.json({ error: { code: "internal", message: "Something went wrong on our side." } }, { status: 500 });
      }
      throw unauthenticated();
    }
  }
  const trusted = (connection: ConnectionRow) =>
    signedByPlatform ? PLATFORM_SIGNED.has(connection.method) : connection.method === "manual_byo" && byoVerified.has(connection.id);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    console.log(`${TAG} malformed=1`);
    return new Response("ok", { status: 200 });
  }
  const parsed = parseWebhook(payload);

  const counts = { echoes: 0, echoesSwitched: 0, echoesSkipped: 0, stored: 0, duplicates: 0, statuses: 0, unknown: 0, inactive: 0, failed: 0, templates: 0, templatesIgnored: 0, templatesNotOurs: 0, ambiguous: 0, health: 0, demoRouted: 0, demoDropped: 0 };
  const errorCodes = new Set<string>();
  const fail = (err: unknown) => {
    counts.failed++;
    errorCodes.add(err instanceof WebhookDbError ? err.code : "other");
  };

  let connections = new Map<string, ConnectionRow>();
  try {
    const ids = [...new Set([...parsed.messages, ...parsed.statuses, ...parsed.echoes].map((item) => item.phoneNumberId))];
    connections = new Map((await deps.findConnections(ids)).map((c) => [c.phoneNumberId, c]));
  } catch (err) {
    fail(err);
  }
  if (deps.noteWebhookSeen) {
    for (const connection of connections.values()) {
      if (byoVerified.has(connection.id)) void deps.noteWebhookSeen(connection.tenantId, connection.id).catch(() => undefined);
    }
  }

  // Which connection may act on an item: signed by our app, for this account, and active.
  const connectionFor = (item: { phoneNumberId: string; wabaId: string }): ConnectionRow | null => {
    const connection = connections.get(item.phoneNumberId);
    if (!connection || !trusted(connection) || connection.wabaId !== item.wabaId) {
      counts.unknown++;
      return null;
    }
    if (connection.status !== "active") {
      counts.inactive++;
      return null;
    }
    return connection;
  };

  if (counts.failed === 0) {
    // One at a time, in the order Meta sent them. One failing item does not stop the others.
    for (const message of parsed.messages) {
      const connection = connectionFor(message);
      if (!connection) continue;
      try {
        // The tenant and channel come from the connection row, never from the message. The one exception is the shared demo
        // number: the business is the one a route code in the visitor's messages names (looked up in route_codes, never taken
        // from the text), and the chat sits on the number's own channel.
        let tenantId = connection.tenantId;
        let storable = toStorable(message);
        if (deps.demo && connection.method === "platform" && message.phoneNumberId === deps.demo.phoneNumberId) {
          const decision = await deps.demo.route({ from: message.from, providerMsgId: message.providerMsgId, text: message.type === "text" ? clean(message.text) : undefined });
          if (decision.action === "drop") {
            counts.demoDropped++;
            continue;
          }
          counts.demoRouted++;
          tenantId = decision.tenantId;
          if (decision.body !== undefined) storable = { ...storable, body: decision.body, meta: { ...storable.meta, routeCode: decision.routeCode } };
        }
        const stored = await deps.storeInboundMessage({
          tenantId,
          channelId: connection.channelId,
          phone: message.from,
          contactName: clean(message.contactName),
          providerMsgId: message.providerMsgId,
          sentAt: message.timestamp,
          ...storable,
        });
        if (stored.inserted) counts.stored++;
        else counts.duplicates++;
        // Sent for a replay too: it may be Meta's retry after the first send failed. The id makes
        // Inngest drop a true duplicate.
        await deps.sendEvent({
          id: `message_received:${stored.messageId}`,
          name: "whatsapp/message.received",
          data: { tenantId, conversationId: stored.conversationId, messageId: stored.messageId },
        });
      } catch (err) {
        fail(err);
      }
    }
    // The owner's replies from the phone app (coexistence): kept as staff messages, and the chat goes to a person if the AI had it. Never a
    // customer's message, so nothing is queued for the AI. The business and channel come from the connection row, never from the payload.
    for (const echo of parsed.echoes) {
      const connection = connectionFor(echo);
      if (!connection) continue;
      if (!deps.storeEchoedMessage) {
        counts.echoesSkipped++;
        continue;
      }
      try {
        const outcome = await deps.storeEchoedMessage({
          tenantId: connection.tenantId,
          channelId: connection.channelId,
          customerPhone: echo.customerPhone,
          providerMsgId: echo.providerMsgId,
          kind: echo.kind,
          body: echo.kind === "text" ? (clean(echo.text) ?? null) : null,
          ...(echo.unsupportedType !== undefined && { unsupportedType: echo.unsupportedType }),
          sentAt: echo.sentAt,
        });
        if (outcome.status === "stored") {
          counts.echoes++;
          if (outcome.switched) {
            counts.echoesSwitched++;
            // Starts the 24-hour wait after which the AI takes the chat back if the team has not replied. Ids only. A repeat of Meta's webhook is
            // a duplicate (no event), and the id makes Inngest drop a repeat of this one.
            await deps.sendEvent({ id: `phone_reply:${outcome.messageId}`, name: "chat.phone_reply", data: { tenantId: connection.tenantId, conversationId: outcome.conversationId } });
          }
        } else {
          counts.echoesSkipped++;
        }
      } catch (err) {
        fail(err);
      }
    }
    for (const status of parsed.statuses) {
      const connection = connectionFor(status);
      if (!connection) continue;
      try {
        await deps.applyMessageStatus({ tenantId: connection.tenantId, providerMsgId: status.providerMsgId, status: status.status });
        counts.statuses++;
      } catch (err) {
        fail(err);
      }
    }
  }

  // Events that name only the WhatsApp business account (a template's status, a number's quality, an account
  // notice): the business is the one whose connection has that account, never anything the payload says.
  const wabaIds = [...new Set([...parsed.templateStatuses, ...parsed.qualityUpdates, ...parsed.accountUpdates].map((item) => item.wabaId))];
  // Runs even when a message of the same batch failed: a message that keeps failing must not hold back the
  // template and quality events, which are idempotent and would only repeat on Meta's retry.
  if (wabaIds.length > 0) {
    const byWaba = new Map<string, ConnectionRow[]>();
    let lookedUp = true;
    try {
      for (const connection of await deps.findConnectionsByWaba(wabaIds)) {
        if (trusted(connection)) byWaba.set(connection.wabaId, [...(byWaba.get(connection.wabaId) ?? []), connection]);
      }
    } catch (err) {
      lookedUp = false;
      fail(err);
    }
    const tenantFor = (wabaId: string): string | null => {
      const tenants = new Set((byWaba.get(wabaId) ?? []).map((c) => c.tenantId));
      if (tenants.size === 1) return [...tenants][0];
      counts.ambiguous++; // no connection of ours has this account, or two businesses claim it
      return null;
    };

    if (lookedUp) {
      for (const template of parsed.templateStatuses) {
        const tenantId = tenantFor(template.wabaId);
        if (!tenantId) continue;
        try {
          // A template that is not this business's, or a status Meta added that we do not know, changes nothing.
          if (!(await deps.templateBelongsToTenant(tenantId, template.metaTemplateId))) {
            counts.templatesNotOurs++;
          } else if (await deps.setTemplateStatus({ metaTemplateId: template.metaTemplateId, event: template.event, reason: template.reason })) {
            counts.templates++;
          } else {
            counts.templatesIgnored++;
          }
        } catch (err) {
          fail(err);
        }
      }
      for (const quality of parsed.qualityUpdates) {
        const connections = byWaba.get(quality.wabaId) ?? [];
        // One account can hold several numbers and the payload names none of them by id: with more than one
        // connection the event is logged and nothing is guessed.
        if (connections.length !== 1) {
          console.log(`${TAG} phone_number_quality_update event=${quality.event} connection=${connections.length === 0 ? "none" : "ambiguous"}`);
          continue;
        }
        const [connection] = connections;
        console.log(`${TAG} phone_number_quality_update event=${quality.event} connection=${connection.id} limit=${quality.currentLimit ?? "-"} rating=${quality.qualityRating ?? "-"}`);
        if (quality.currentLimit === undefined && quality.qualityRating === undefined) continue;
        try {
          await deps.updateConnectionHealth({ tenantId: connection.tenantId, connectionId: connection.id, messagingLimit: quality.currentLimit, qualityRating: quality.qualityRating });
          counts.health++;
        } catch (err) {
          fail(err);
        }
      }
      for (const account of parsed.accountUpdates) {
        const ids = (byWaba.get(account.wabaId) ?? []).map((c) => c.id);
        console.log(`${TAG} account_update event=${account.event} connection=${ids.length === 0 ? "none" : ids.join(",")}`);
      }
    }
  }

  // Webhook fields we do not handle, by name (a count each), never an error.
  const unknownFields = new Map<string, number>();
  for (const item of parsed.ignored) if (item.reason === "unsupported_field") unknownFields.set(item.field, (unknownFields.get(item.field) ?? 0) + 1);
  const fields = unknownFields.size > 0 ? ` fields=${[...unknownFields].map(([name, n]) => `${name}:${n}`).join(",")}` : "";

  const demo = counts.demoRouted + counts.demoDropped > 0 ? ` demo_routed=${counts.demoRouted} demo_dropped=${counts.demoDropped}` : "";
  const codes = errorCodes.size > 0 ? ` error_codes=${[...errorCodes].join(",")}` : "";
  console.log(
    `${TAG} messages=${parsed.messages.length} stored=${counts.stored} duplicates=${counts.duplicates} echoes=${parsed.echoes.length} echoes_stored=${counts.echoes} echoes_switched=${counts.echoesSwitched} echoes_skipped=${counts.echoesSkipped} statuses=${counts.statuses} ` +
      `templates=${parsed.templateStatuses.length} templates_set=${counts.templates} templates_ignored=${counts.templatesIgnored} templates_not_ours=${counts.templatesNotOurs} accounts_unmatched=${counts.ambiguous} health=${counts.health} ignored=${parsed.ignored.length} unknown=${counts.unknown} inactive=${counts.inactive} failed=${counts.failed}${codes}${fields}${demo}`,
  );

  if (counts.failed > 0) {
    return Response.json({ error: { code: "internal", message: "Something went wrong on our side." } }, { status: 500 });
  }
  return new Response("ok", { status: 200 });
}

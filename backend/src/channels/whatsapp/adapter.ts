import { SendResult, TEMPLATE_BODY_MAX, type ErrorCode } from "@pakka/types";
import { z } from "zod";
import { connectionSecretContext, decryptSecret } from "../../lib/crypto";
import { serverEnv, type ServerEnv } from "../../lib/env";
import { Interactive } from "../../notify/interactive";
import { mapMetaError } from "./meta-errors";
import { normalizeE164 } from "./phone";

// The WhatsApp send side (module 1): sendText, sendTemplate, sendInteractive and markRead on Meta's Graph API.
// notify.send is the only caller (through the MessageSender in message-sender.ts); nothing else sends
// messages.
//
// - Returns a result, never throws. A failure carries one of the shared error codes, a retryable flag,
//   and outcomeUnknown (true when the message may have gone out: timeout, network failure, unreadable
//   answer). The adapter never retries: a retry after a timeout could send twice.
// - The tenant's token is decrypted per call (AAD context from connectionSecretContext) and goes only
//   into the Authorization header. It is never stored, logged, or put in a result.
// - Error messages are fixed strings (ADAPTER_MESSAGES). Meta's own text is never passed on, and `meta`
//   holds integers only: Meta's code, its subcode and the HTTP status.
// - No window check: notify.send decides free text or template; the adapter only maps Meta's 131047.
// - No database access, no logging.

const GRAPH_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const TEXT_MAX = 4096;
const WAMID_MAX = 256;

export const ADAPTER_MESSAGES = {
  validation_failed: "The message could not be sent because the number or the text is not valid.",
  outside_window: "WhatsApp only allows an approved template outside the 24-hour window, so the message was not sent.",
  rate_limited: "WhatsApp is limiting messages right now. Try again later.",
  whatsapp_not_connected: "The WhatsApp connection could not be used. Reconnect the number and try again.",
  upstream_failed: "WhatsApp did not accept the request. Try again in a moment.",
  no_answer: "WhatsApp did not answer in time, so the message may or may not have been sent.",
  unclear_answer: "WhatsApp's answer could not be understood, so the message may or may not have been sent.",
  internal: "The message could not be sent because of a problem on our side.",
} as const;

/** The connection row subset the adapter needs. Server-only: it holds the encrypted token. */
export type SendConnection = {
  tenantId: string;
  connectionId: string;
  phoneNumberId: string;
  tokenEnc: string;
};

export type AdapterDeps = {
  /** Injected so tests need no network. */
  fetch?: typeof fetch;
  /** Request timeout in milliseconds; default 10 seconds. */
  timeoutMs?: number;
  /** Defaults to serverEnv(). */
  env?: Pick<ServerEnv, "ENCRYPTION_KEY" | "META_GRAPH_API_VERSION">;
};

export type AdapterError = {
  code: ErrorCode;
  retryable: boolean;
  outcomeUnknown: boolean;
  message: string;
  /** Integers from Meta's answer only; never text. */
  meta?: { code?: number; subcode?: number; httpStatus?: number };
};
export type AdapterResult<T> = { ok: true; value: T } | { ok: false; error: AdapterError };

const fail = (
  code: ErrorCode,
  message: string,
  extra: Partial<Pick<AdapterError, "retryable" | "outcomeUnknown" | "meta">> = {},
): AdapterResult<never> => ({
  ok: false,
  error: { code, retryable: false, outcomeUnknown: false, message, ...extra },
});

const failFor = (code: "validation_failed" | "whatsapp_not_connected" | "internal") => fail(code, ADAPTER_MESSAGES[code]);

type Prepared = { url: string; token: string };

/** Everything that can be checked or decrypted before the network: returns a failure or the URL and token. */
function prepare(connection: SendConnection, deps: AdapterDeps): AdapterResult<Prepared> {
  if (!/^\d{1,32}$/.test(connection.phoneNumberId)) return failFor("validation_failed");

  let env: NonNullable<AdapterDeps["env"]>;
  try {
    env = deps.env ?? serverEnv();
  } catch {
    return failFor("internal");
  }
  if (env.ENCRYPTION_KEY === undefined || !/^v\d+\.\d+$/.test(String(env.META_GRAPH_API_VERSION))) {
    return failFor("internal");
  }

  let context;
  try {
    context = connectionSecretContext({
      column: "token_enc",
      tenantId: connection.tenantId,
      connectionId: connection.connectionId,
    });
  } catch {
    return failFor("internal");
  }
  let token: string;
  try {
    token = decryptSecret(connection.tokenEnc, context, env);
  } catch {
    // Tampered, copied from another row, or encrypted with another key: indistinguishable by design.
    return failFor("whatsapp_not_connected");
  }
  if (token === "") return failFor("whatsapp_not_connected");

  return {
    ok: true,
    value: { url: `${GRAPH_URL}/${env.META_GRAPH_API_VERSION}/${connection.phoneNumberId}/messages`, token },
  };
}

type Reply = { kind: "reply"; status: number; text: string } | { kind: "no_answer" };

/** One POST with a timeout that holds even if fetch ignores the abort signal. Never throws. */
async function post(prepared: Prepared, body: unknown, deps: AdapterDeps): Promise<Reply> {
  const send = deps.fetch ?? fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
  try {
    const request = (async (): Promise<Reply> => {
      const res = await send(prepared.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${prepared.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { kind: "reply", status: res.status, text: await res.text() };
    })();
    request.catch(() => undefined); // if the timeout wins, a later rejection must not go unhandled
    const winner = await Promise.race([request, timeout]);
    return winner === "timeout" ? { kind: "no_answer" } : winner;
  } catch {
    return { kind: "no_answer" };
  } finally {
    clearTimeout(timer);
  }
}

const noAnswer = () => fail("upstream_failed", ADAPTER_MESSAGES.no_answer, { retryable: true, outcomeUnknown: true });
const unclearAnswer = (httpStatus: number) =>
  fail("upstream_failed", ADAPTER_MESSAGES.unclear_answer, { outcomeUnknown: true, meta: { httpStatus } });

const asInteger = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : undefined);
const MetaErrorBody = z.looseObject({
  error: z.looseObject({ code: z.unknown().optional(), error_subcode: z.unknown().optional() }),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Turns a non-2xx answer into a typed failure using only Meta's numbers. */
function failFromMeta(status: number, json: unknown): AdapterResult<never> {
  const parsed = MetaErrorBody.safeParse(json);
  const code = parsed.success ? asInteger(parsed.data.error.code) : undefined;
  const subcode = parsed.success ? asInteger(parsed.data.error.error_subcode) : undefined;
  const mapped = mapMetaError(code, status);
  const message = mapped.code in ADAPTER_MESSAGES ? ADAPTER_MESSAGES[mapped.code as keyof typeof ADAPTER_MESSAGES] : ADAPTER_MESSAGES.upstream_failed;
  return fail(mapped.code, message, {
    retryable: mapped.retryable,
    meta: {
      ...(code !== undefined && { code }),
      ...(subcode !== undefined && { subcode }),
      httpStatus: status,
    },
  });
}

const SendBody = z.looseObject({ messages: z.array(z.looseObject({ id: z.string().min(1) })).min(1) });
const ReadBody = z.looseObject({ success: z.boolean() });

/** Sends one message, already checked by the caller, to an E.164 number and returns its wamid. */
async function sendMessage(
  connection: SendConnection,
  number: string,
  message: { type: "text" | "template" | "interactive" } & Record<string, unknown>,
  deps: AdapterDeps,
): Promise<AdapterResult<SendResult>> {
  const prepared = prepare(connection, deps);
  if (!prepared.ok) return prepared;

  const reply = await post(prepared.value, { messaging_product: "whatsapp", recipient_type: "individual", to: number, ...message }, deps);
  if (reply.kind === "no_answer") return noAnswer();
  const json = parseJson(reply.text);
  if (reply.status < 200 || reply.status >= 300) return failFromMeta(reply.status, json);

  const parsed = SendBody.safeParse(json);
  if (!parsed.success) return unclearAnswer(reply.status);
  return { ok: true, value: SendResult.parse({ providerMsgId: parsed.data.messages[0].id }) };
}

export async function sendText(
  connection: SendConnection,
  to: string,
  body: string,
  deps: AdapterDeps = {},
): Promise<AdapterResult<SendResult>> {
  try {
    const number = normalizeE164(to);
    if (number === null || typeof body !== "string" || body.trim() === "" || body.length > TEXT_MAX) {
      return failFor("validation_failed");
    }
    return await sendMessage(connection, number, { type: "text", text: { body, preview_url: false } }, deps);
  } catch {
    return failFor("internal");
  }
}

/**
 * An approved template: its exact versioned name, its language code and its body variables in {{1}}… order. `buttons`
 * are the payloads of its quick-reply buttons, in their order: a tap comes back with that payload (our button id), as a
 * tap on an interactive button does. Leave them out to let Meta return the button's text.
 */
export type TemplateMessage = { name: string; language: string; params: string[]; buttons?: string[] };

/** Meta allows up to 10 quick-reply buttons on a template; our ids are well under this length. */
const TEMPLATE_BUTTONS_MAX = 10;
const BUTTON_PAYLOAD_MAX = 256;

// Meta's rules: names are lowercase letters, digits and underscores; languages are codes like en, ta or
// en_US. A variable may not be empty or contain a newline or tab or more than 4 spaces in a row (Meta
// answers 132018), and the whole body is at most 1024 characters.
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const validParam = (param: unknown) =>
  typeof param === "string" && param.trim() !== "" && param.length <= TEMPLATE_BODY_MAX && !/[\r\n\t]| {5}/.test(param);

/**
 * Sends an approved template, the only kind of message allowed outside the 24-hour window: body variables, and the
 * payloads of its quick-reply buttons when given. Header variables need a new parameter here first.
 */
export async function sendTemplate(
  connection: SendConnection,
  to: string,
  template: TemplateMessage,
  deps: AdapterDeps = {},
): Promise<AdapterResult<SendResult>> {
  try {
    const number = normalizeE164(to);
    const { name, language, params, buttons = [] }: Partial<TemplateMessage> = template ?? {};
    if (
      number === null ||
      typeof name !== "string" ||
      !TEMPLATE_NAME.test(name) ||
      typeof language !== "string" ||
      !TEMPLATE_LANGUAGE.test(language) ||
      !Array.isArray(params) ||
      !params.every(validParam) ||
      !Array.isArray(buttons) ||
      buttons.length > TEMPLATE_BUTTONS_MAX ||
      !buttons.every((payload) => typeof payload === "string" && payload !== "" && payload.length <= BUTTON_PAYLOAD_MAX)
    ) {
      return failFor("validation_failed");
    }
    const components = [
      ...(params.length > 0 ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] : []),
      ...buttons.map((payload, index) => ({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }] })),
    ];
    return await sendMessage(
      connection,
      number,
      { type: "template", template: { name, language: { code: language }, ...(components.length > 0 && { components }) } },
      deps,
    );
  } catch {
    return failFor("internal");
  }
}

/** Meta's request shape for reply buttons ("button") or a list ("list"). Header and footer are text only. */
function graphInteractive(message: Interactive) {
  const frame = {
    ...(message.header !== undefined && { header: { type: "text", text: message.header } }),
    body: { text: message.body },
    ...(message.footer !== undefined && { footer: { text: message.footer } }),
  };
  if (message.type === "buttons") {
    return { type: "button", ...frame, action: { buttons: message.buttons.map(({ id, title }) => ({ type: "reply", reply: { id, title } })) } };
  }
  return {
    type: "list",
    ...frame,
    action: {
      button: message.button,
      sections: message.sections.map((section) => ({
        ...(section.title !== undefined && { title: section.title }),
        rows: section.rows.map(({ id, title, description }) => ({ id, title, ...(description !== undefined && { description }) })),
      })),
    },
  };
}

/**
 * Sends reply buttons or a list (notify/interactive.ts). Free-form like text, so WhatsApp refuses it outside the
 * 24-hour window (131047, outside_window). Anything over Meta's limits is refused before the network.
 */
export async function sendInteractive(
  connection: SendConnection,
  to: string,
  message: Interactive,
  deps: AdapterDeps = {},
): Promise<AdapterResult<SendResult>> {
  try {
    const number = normalizeE164(to);
    const parsed = Interactive.safeParse(message);
    if (number === null || !parsed.success) return failFor("validation_failed");
    return await sendMessage(connection, number, { type: "interactive", interactive: graphInteractive(parsed.data) }, deps);
  } catch {
    return failFor("internal");
  }
}

export async function markRead(
  connection: SendConnection,
  wamid: string,
  deps: AdapterDeps = {},
): Promise<AdapterResult<{ success: true }>> {
  try {
    if (typeof wamid !== "string" || wamid.length < 1 || wamid.length > WAMID_MAX) return failFor("validation_failed");
    const prepared = prepare(connection, deps);
    if (!prepared.ok) return prepared;

    const reply = await post(prepared.value, { messaging_product: "whatsapp", status: "read", message_id: wamid }, deps);
    if (reply.kind === "no_answer") return noAnswer();
    const json = parseJson(reply.text);
    if (reply.status < 200 || reply.status >= 300) return failFromMeta(reply.status, json);

    const parsed = ReadBody.safeParse(json);
    if (!parsed.success) return unclearAnswer(reply.status);
    if (!parsed.data.success) return fail("upstream_failed", ADAPTER_MESSAGES.upstream_failed, { meta: { httpStatus: reply.status } });
    return { ok: true, value: { success: true } };
  } catch {
    return failFor("internal");
  }
}

import { LlmError, type LlmClient, type LlmResult } from "../agent/llm/anthropic";
import { SendError, type MessageSender, type SenderFactory } from "../notify/sender";
import { parseFailureList, parseTenantList, type InjectableFailure, type ServerEnv } from "./env";

// Failure injection (Day 7): makes the language model or WhatsApp fail for named test businesses, so the failure tests
// (Dev 1's conversation suite, the staging exit test) can prove a failure never sends a second message, spends a
// credit twice or leaks a secret. Each failure looks exactly like the real one to the code that handles it:
//   llm_timeout            every model call throws LlmError("timeout"), as when a call runs out of time
//   llm_bad_json           the models that answer in JSON (extraction, the lead card's summary) answer with a cut-off
//                          object, every time, so a retry fails too ("malformed JSON twice"); the reply model is untouched
//   whatsapp_send_error    WhatsApp refuses every message: SendError upstream_failed, retryable (a Meta 5xx)
//   whatsapp_send_timeout  WhatsApp never answers: upstream_failed, outcomeUnknown (the message may have gone out, so
//                          it must never be resent)
// On staging: FAILURE_INJECTION and FAILURE_INJECTION_TENANTS (lib/env.ts). Tests build one with failureInjection().

export interface FailureInjection {
  /** Whether `failure` is switched on for this business. */
  breaks(tenantId: string, failure: InjectableFailure): boolean;
}

export function failureInjection(failures: readonly InjectableFailure[], tenantIds: readonly string[]): FailureInjection {
  const on = new Set(failures);
  const tenants = new Set(tenantIds.map((id) => id.toLowerCase()));
  return { breaks: (tenantId, failure) => on.has(failure) && tenants.has(tenantId.toLowerCase()) };
}

/** From the environment; null (nothing is broken) unless both settings are there. The env schema refuses a bad value at startup. */
export function failureInjectionFromEnv(env: Pick<ServerEnv, "FAILURE_INJECTION" | "FAILURE_INJECTION_TENANTS">): FailureInjection | null {
  if (!env.FAILURE_INJECTION || !env.FAILURE_INJECTION_TENANTS) return null;
  const failures = parseFailureList(env.FAILURE_INJECTION);
  const tenants = parseTenantList(env.FAILURE_INJECTION_TENANTS);
  if (!failures || !tenants) return null;
  console.warn(`[failure-injection] ON for ${tenants.length} test business(es): ${failures.join(", ")}`);
  return failureInjection(failures, tenants);
}

let fromServerEnv: FailureInjection | null | undefined;

/**
 * The server's own, built (and announced in the log) once. It reads just its two settings: the server validated the
 * whole environment at startup (server/main.ts), refusing a bad list or injection alongside live PayU, before anything
 * asks for this.
 */
export function serverFailureInjection(): FailureInjection | null {
  if (fromServerEnv === undefined) {
    fromServerEnv = failureInjectionFromEnv({ FAILURE_INJECTION: process.env.FAILURE_INJECTION, FAILURE_INJECTION_TENANTS: process.env.FAILURE_INJECTION_TENANTS });
  }
  return fromServerEnv;
}

/** The roles whose answer is parsed as a JSON object (agent/llm/json.ts). */
const JSON_ROLES: ReadonlySet<string> = new Set(["extraction", "summary"]);
/** What a model that stops in the middle of its object returns. */
export const INJECTED_BAD_JSON = '{"language": "en", "intent": "question", "fields": {';

const injectedResult = (text: string): LlmResult => ({
  text,
  model: "injected",
  stopReason: "max_tokens",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0,
  latencyMs: 0,
  attempts: 1,
  requestId: null,
});

/** The model client, failing as `injection` says for its businesses. Without an injection it is the client itself. */
export function withLlmFailures(client: LlmClient, injection: FailureInjection | null): LlmClient {
  if (!injection) return client;
  return {
    async complete(request) {
      if (injection.breaks(request.tenantId, "llm_timeout")) throw new LlmError("timeout", undefined, 1);
      if (JSON_ROLES.has(request.role) && injection.breaks(request.tenantId, "llm_bad_json")) return injectedResult(INJECTED_BAD_JSON);
      return client.complete(request);
    },
  };
}

const failingSender = (error: () => SendError): MessageSender => {
  const fail = async (): Promise<never> => {
    throw error();
  };
  return { sendText: fail, sendTemplate: fail, sendInteractive: fail };
};

/** notify.send's sender factory, failing as `injection` says for its businesses. Without an injection it is the factory itself. */
export function withSendFailures(factory: SenderFactory, injection: FailureInjection | null): SenderFactory {
  if (!injection) return factory;
  return async (ids) => {
    if (injection.breaks(ids.tenantId, "whatsapp_send_timeout")) {
      return failingSender(() => new SendError("upstream_failed", "WhatsApp did not answer (injected failure).", { retryable: true, outcomeUnknown: true }));
    }
    if (injection.breaks(ids.tenantId, "whatsapp_send_error")) {
      return failingSender(() => new SendError("upstream_failed", "WhatsApp refused the message (injected failure).", { retryable: true }));
    }
    return factory(ids);
  };
}

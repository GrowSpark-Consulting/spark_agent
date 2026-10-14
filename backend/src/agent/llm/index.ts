import { serverEnv } from "../../lib/env";
import { serverFailureInjection, withLlmFailures } from "../../lib/failure-injection";
import { createAnthropicClient, type LlmClient } from "./anthropic";
import { tracerFromEnv, type TracerHandle } from "./tracing";

// The agent's language-model client for this process: built once, from the server's environment. The pipeline
// steps (extraction, reply) call `llm().complete(...)`. ANTHROPIC_API_KEY is required by the environment
// schema, so the server does not start without it; the Langfuse keys are optional and tracing is off without them.

export { LlmError, type LlmErrorCode, type LlmMessage, type LlmRequest, type LlmResult, type LlmClient, type SystemBlock } from "./anthropic";
export { parseJsonObject } from "./json";
export { MODELS, type LlmRole } from "./models";

let tracing: TracerHandle | undefined;
let client: LlmClient | undefined;

export function llm(): LlmClient {
  if (!client) {
    const env = serverEnv();
    tracing = tracerFromEnv(env);
    // On staging, failure injection may break it for named test businesses (lib/failure-injection.ts).
    client = withLlmFailures(createAnthropicClient(env.ANTHROPIC_API_KEY, tracing.tracer), serverFailureInjection());
  }
  return client;
}

/** For a clean shutdown (SIGTERM): sends the traces that are waiting. Resolves, never rejects, and takes at most a few seconds. */
export async function shutdownLlm(): Promise<void> {
  await tracing?.shutdown();
}

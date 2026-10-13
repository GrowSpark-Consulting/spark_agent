import { z } from "zod";

// Server-only: never import this from a client component.
// Values are validated, never printed; errors name the variable only.

const secret = z.string().min(1);

/**
 * "https://app.example.com, http://localhost:3000" → each entry's origin. Null when any entry is
 * not a bare http(s) origin (a path, credentials or a wildcard), so a typo can't widen CORS.
 */
export function parseOrigins(list: string): string[] | null {
  const origins: string[] = [];
  for (const raw of list.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw.includes("*") || !URL.canParse(raw)) return null;
    const url = new URL(raw);
    const bare = /^https?:$/.test(url.protocol) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
    if (!bare || raw.replace(/\/$/, "") !== url.origin) return null;
    origins.push(url.origin);
  }
  return origins;
}

const serverEnvSchema = z
  .object({
  // The frontend's address (Vercel). The API accepts browser requests from it (CORS).
  NEXT_PUBLIC_APP_URL: z.url(),
  // The Supabase project URL and anon/publishable key: the API verifies the caller's access token
  // and reads as that user (row-level security), like the frontend does. Same names on both hosts.
  NEXT_PUBLIC_SUPABASE_URL: z.url({ protocol: /^https?$/, error: "must be the project's https API URL, e.g. https://<ref>.supabase.co" }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: secret,
  SUPABASE_SERVICE_ROLE_KEY: secret,

  // Set by Railway (the environment's name, e.g. staging); only labels traces. Unset locally.
  RAILWAY_ENVIRONMENT_NAME: z.string().min(1).optional(),

  // The API server (backend/src/server). Railway sets PORT; locally the API runs on 4000.
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().min(1).default("0.0.0.0"),
  // Browser origins allowed besides NEXT_PUBLIC_APP_URL, comma-separated (e.g. the staging frontend
  // or http://localhost:3000). Exact origins only: never "*".
  CORS_ALLOWED_ORIGINS: z
    .string()
    .refine((v) => parseOrigins(v) !== null, "must be comma-separated origins such as https://staging.pakkaagent.in")
    .transform((v) => parseOrigins(v) ?? [])
    .optional(),

  // The knowledge base reads this on every upload and every answer, so the server won't start without it.
  EMBEDDINGS_API_KEY: secret,
  // The Atlas endpoint for Voyage models (our key is an Atlas model API key). A Voyage-direct key
  // would need https://api.voyageai.com/v1 instead. 1024 dimensions, to match kb_chunks.embedding.
  // https only: the key is sent to it, in every environment.
  EMBEDDINGS_BASE_URL: z.url({ protocol: /^https$/, error: "must be an https URL" }).default("https://ai.mongodb.com/v1"),
  EMBEDDINGS_MODEL: z.string().min(1).default("voyage-4"),

  // The agent calls Anthropic on every message (extraction on Haiku, replies on Sonnet), so the server won't
  // start without it. One key per environment.
  ANTHROPIC_API_KEY: secret,

  // Optional until the module that uses them lands; make each one required in
  // the same PR that first reads it.

  NEXT_PUBLIC_META_APP_ID: secret.optional(),
  META_APP_SECRET: secret.optional(),
  NEXT_PUBLIC_META_ES_CONFIG_ID: secret.optional(),
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "must look like v26.0")
    // One pinned version; an unset variable can never build a "/undefined/" Graph API URL.
    .default("v26.0"),
  META_WEBHOOK_VERIFY_TOKEN: secret.optional(),
  // This API's public https origin (e.g. https://sparkagent-production-dc1a.up.railway.app). Builds the webhook
  // callback URL shown to a client who connects their own Meta app. Unset: that screen says it isn't available.
  API_PUBLIC_URL: z
    .url({ protocol: /^https$/, error: "must be the API's https origin" })
    .refine((v) => new URL(v).pathname === "/" && !new URL(v).search && !new URL(v).hash, "must be an origin only, no path")
    .optional(),
  // Spark Agent's Business Portfolio ID, shown for partner access. Not a secret. Unset: the screen says it isn't available.
  META_PARTNER_BUSINESS_ID: z.string().regex(/^\d{5,20}$/, "must be digits only").optional(),

  // The link in the privacy notice the first AI reply to a contact carries (docs/handover.md, "Consent (DPDP)").
  // Optional: the default is the product's own policy page. Must be https (it is sent to customers).
  PRIVACY_POLICY_URL: z
    .string()
    .url()
    .max(300)
    .refine((value) => /^https:\/\/\S+$/.test(value), "must be an https URL with no spaces or line breaks")
    .default("https://pakkaagent.in/privacy"),
  META_SYSTEM_USER_TOKEN: secret.optional(),
  WHATSAPP_DEMO_WABA_ID: secret.optional(),
  WHATSAPP_DEMO_PHONE_NUMBER_ID: secret.optional(),
  // Embedded Signup (POST /api/onboarding/whatsapp/embedded-signup) stays off until Meta approves the app; off, the route answers not_available.
  EMBEDDED_SIGNUP_ENABLED: z
    .enum(["true", "false"], { error: 'must be "true" or "false"' })
    .default("false")
    .transform((v) => v === "true"),
  WHATSAPP_REGISTER_PIN: z
    .string()
    .regex(/^\d{6}$/, "must be 6 digits")
    .optional(),

  GOOGLE_CLIENT_ID: secret.optional(),
  GOOGLE_CLIENT_SECRET: secret.optional(),
  // Exactly as registered in the Google Cloud OAuth client: <API origin>/api/calendar/google/callback.
  GOOGLE_REDIRECT_URI: z.url({ protocol: /^https?$/ }).optional(),

  // PayU (billing: plan auto-debit, top-ups, the setup fee). The merchant key and salt from PayU's dashboard, both or
  // neither: without them billing answers not_available. PAYU_MODE picks PayU's test or live hosts; test unless it is
  // exactly "live", so a missing setting can never move real money.
  PAYU_MERCHANT_KEY: secret.optional(),
  PAYU_MERCHANT_SALT: secret.optional(),
  PAYU_MODE: z.enum(["test", "live"], { error: 'must be "test" or "live"' }).default("test"),

  INNGEST_EVENT_KEY: secret.optional(),
  INNGEST_SIGNING_KEY: secret.optional(),
  // Read by the Inngest SDK: the API's public origin, so the URL Inngest syncs never comes from a
  // request's Host header (e.g. https://api.pakkaagent.in).
  INNGEST_SERVE_ORIGIN: z.url().optional(),

  RESEND_API_KEY: secret.optional(),
  SENTRY_DSN: z.url().optional(),
  // LLM tracing. Both keys or neither: with neither, tracing is off and nothing is sent anywhere.
  LANGFUSE_PUBLIC_KEY: secret.optional(),
  LANGFUSE_SECRET_KEY: secret.optional(),
  // The Langfuse project's address; the EU cloud (https://cloud.langfuse.com) when unset. https only: the keys are sent to it.
  LANGFUSE_BASE_URL: z.url({ protocol: /^https$/, error: "must be an https URL, e.g. https://cloud.langfuse.com" }).optional(),
  // "true" also sends the customer's words and the replies to Langfuse, with phone numbers and emails masked and
  // each cut to 2,000 characters. Off unless it is exactly "true": by default a trace carries no message text.
  LANGFUSE_CAPTURE_TEXT: z.enum(["true", "false"], { error: 'must be "true" or "false"' }).optional(),

  ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, "base64").length === 32,
      "must be 32 random bytes, base64 (openssl rand -base64 32)",
    )
    .optional(),
  })
  // The two Langfuse keys go together: one alone would silently leave tracing off.
  .refine((env) => (env.LANGFUSE_PUBLIC_KEY === undefined) === (env.LANGFUSE_SECRET_KEY === undefined), {
    message: "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set together",
    path: ["LANGFUSE_SECRET_KEY"],
  })
  .refine((env) => (env.PAYU_MERCHANT_KEY === undefined) === (env.PAYU_MERCHANT_SALT === undefined), {
    message: "PAYU_MERCHANT_KEY and PAYU_MERCHANT_SALT must be set together",
    path: ["PAYU_MERCHANT_SALT"],
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment:\n  ${problems.join("\n  ")}`);
    this.name = "EnvError";
  }
}

export function parseServerEnv(
  source: Record<string, string | undefined>,
): ServerEnv {
  // `KEY=` in a .env file means unset, not an empty secret.
  const present = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = serverEnvSchema.safeParse(present);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  return result.data;
}

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}

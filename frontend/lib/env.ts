import { z } from "zod";

// The frontend's settings. All are public by design (NEXT_PUBLIC_*, inlined into the browser bundle;
// the anon / publishable key is limited by row-level security). Server secrets live only on the API
// (backend/, Railway) and never here.
const PublicEnv = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .url()
    .refine((v) => /^https?:$/.test(new URL(v).protocol), "must be the project's https API URL, e.g. https://<ref>.supabase.co")
    .refine((v) => !new URL(v).username && !new URL(v).password, "must not contain credentials"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, "is required"),
});

export interface SupabasePublicConfig {
  url: string;
  anonKey: string;
}

/** Validates the public Supabase settings. Errors name the variable, never its value. */
export function parsePublicEnv(source: Record<string, string | undefined>): SupabasePublicConfig {
  const result = PublicEnv.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`);
    throw new Error(`Invalid Supabase configuration: ${problems.join("; ")}`);
  }
  return { url: result.data.NEXT_PUBLIC_SUPABASE_URL, anonKey: result.data.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

export function supabasePublicConfig(): SupabasePublicConfig {
  // Referenced literally so Next.js can inline them where needed.
  return parsePublicEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}

// The API (backend/, on Railway): its origin only, e.g. https://api.pakkaagent.in or
// http://localhost:4000. Paths such as /api/templates are added by lib/api/client.ts.
function apiUrlProblem(value: string | undefined): string | null {
  if (!value) return "is required";
  if (!URL.canParse(value)) return "must be the API's address, e.g. https://api.pakkaagent.in";
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) return "must be an http(s) address";
  if (url.username || url.password) return "must not contain credentials";
  if (url.pathname !== "/" || url.search || url.hash) return "must be an origin without a path, e.g. https://api.pakkaagent.in";
  return null;
}

/** Validates NEXT_PUBLIC_API_URL and returns its origin. Errors name the variable, never its value. */
export function parseApiUrl(value: string | undefined): string {
  const problem = apiUrlProblem(value);
  if (problem) throw new Error(`Invalid API configuration: NEXT_PUBLIC_API_URL ${problem}`);
  return new URL(value!).origin;
}

export function apiBaseUrl(): string {
  // Referenced literally so Next.js inlines it into the browser bundle at build time.
  return parseApiUrl(process.env.NEXT_PUBLIC_API_URL);
}

// Meta Embedded Signup (Connect with Facebook): our Meta app id and the Facebook Login for Business
// configuration id. Both are public. Optional: until both are set, the real popup stays switched off.
export type MetaSignupConfig =
  | { status: "ready"; appId: string; configId: string }
  | { status: "off"; problems: string[] };

const META_ID = /^\d{1,32}$/;

/** Validates the Embedded Signup settings. Problems name the variable, never its value. */
export function parseMetaSignupEnv(source: Record<string, string | undefined>): MetaSignupConfig {
  const appId = source.NEXT_PUBLIC_META_APP_ID?.trim() ?? "";
  const configId = source.NEXT_PUBLIC_META_ES_CONFIG_ID?.trim() ?? "";
  const problems: string[] = [];
  for (const [name, value] of [["NEXT_PUBLIC_META_APP_ID", appId], ["NEXT_PUBLIC_META_ES_CONFIG_ID", configId]] as const) {
    if (!value) problems.push(`${name} is not set`);
    else if (!META_ID.test(value)) problems.push(`${name} must be a numeric id`);
  }
  return problems.length ? { status: "off", problems } : { status: "ready", appId, configId };
}

export function metaSignupConfig(): MetaSignupConfig {
  // Referenced literally so Next.js inlines them into the browser bundle at build time.
  return parseMetaSignupEnv({
    NEXT_PUBLIC_META_APP_ID: process.env.NEXT_PUBLIC_META_APP_ID,
    NEXT_PUBLIC_META_ES_CONFIG_ID: process.env.NEXT_PUBLIC_META_ES_CONFIG_ID,
  });
}

/**
 * Where "Book a setup call" goes: an https address, optional. Public by design (NEXT_PUBLIC_*). Unset or invalid, the connect page tells the
 * person to ask whoever sent them the link instead of showing a button that goes nowhere.
 */
export function parseSetupCallUrl(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text || !URL.canParse(text)) return null;
  const url = new URL(text);
  return url.protocol === "https:" ? url.toString() : null;
}

export function setupCallUrl(): string | null {
  // Referenced literally so Next.js inlines it into the browser bundle at build time.
  return parseSetupCallUrl(process.env.NEXT_PUBLIC_SETUP_CALL_URL);
}

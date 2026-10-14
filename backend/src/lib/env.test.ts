import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvError, parseServerEnv } from "./env";

const base = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  EMBEDDINGS_API_KEY: "test-embeddings-key",
  ANTHROPIC_API_KEY: "test-anthropic-key",
};

describe("parseServerEnv", () => {
  it("accepts the minimum local setup", () => {
    expect(parseServerEnv(base).NEXT_PUBLIC_SUPABASE_URL).toBe(
      "http://127.0.0.1:54321",
    );
  });

  it("treats empty values as unset", () => {
    expect(() =>
      parseServerEnv({ ...base, SUPABASE_SERVICE_ROLE_KEY: "" }),
    ).toThrow(EnvError);
    expect(parseServerEnv({ ...base, META_APP_SECRET: "" }).META_APP_SECRET).toBeUndefined();
  });

  describe("the language model settings", () => {
    it("requires ANTHROPIC_API_KEY: the agent calls Anthropic on every message", () => {
      const without = Object.fromEntries(Object.entries(base).filter(([key]) => key !== "ANTHROPIC_API_KEY"));
      expect(() => parseServerEnv(without)).toThrow(/ANTHROPIC_API_KEY/);
      expect(() => parseServerEnv({ ...base, ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY/); // empty is unset
    });

    it("lets Langfuse stay off: no keys, no tracing", () => {
      const env = parseServerEnv(base);
      expect(env.LANGFUSE_PUBLIC_KEY).toBeUndefined();
      expect(env.LANGFUSE_SECRET_KEY).toBeUndefined();
    });

    it("takes the two Langfuse keys together, and refuses one without the other, without echoing either", () => {
      expect(parseServerEnv({ ...base, LANGFUSE_PUBLIC_KEY: "pk-lf-1", LANGFUSE_SECRET_KEY: "sk-lf-2" }).LANGFUSE_PUBLIC_KEY).toBe("pk-lf-1");
      for (const only of [{ LANGFUSE_PUBLIC_KEY: "pk-lf-1" }, { LANGFUSE_SECRET_KEY: "sk-lf-2" }]) {
        try {
          parseServerEnv({ ...base, ...only });
          expect.unreachable();
        } catch (e) {
          expect(e).toBeInstanceOf(EnvError);
          expect((e as EnvError).message).toContain("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set together");
          expect((e as EnvError).message).not.toMatch(/pk-lf-1|sk-lf-2/);
        }
      }
    });

    it("takes the Langfuse address as an https URL, and nothing else", () => {
      expect(parseServerEnv({ ...base, LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com" }).LANGFUSE_BASE_URL).toBe("https://us.cloud.langfuse.com");
      expect(() => parseServerEnv({ ...base, LANGFUSE_BASE_URL: "http://langfuse.example.com" })).toThrow(/LANGFUSE_BASE_URL/); // the keys travel to it
      expect(() => parseServerEnv({ ...base, LANGFUSE_BASE_URL: "ftp://example.com" })).toThrow(/LANGFUSE_BASE_URL/);
      expect(() => parseServerEnv({ ...base, LANGFUSE_BASE_URL: "not a url" })).toThrow(/LANGFUSE_BASE_URL/);
    });

    it('takes LANGFUSE_CAPTURE_TEXT as exactly "true" or "false"', () => {
      expect(parseServerEnv({ ...base, LANGFUSE_CAPTURE_TEXT: "true" }).LANGFUSE_CAPTURE_TEXT).toBe("true");
      expect(parseServerEnv({ ...base, LANGFUSE_CAPTURE_TEXT: "false" }).LANGFUSE_CAPTURE_TEXT).toBe("false");
      expect(() => parseServerEnv({ ...base, LANGFUSE_CAPTURE_TEXT: "yes" })).toThrow(/LANGFUSE_CAPTURE_TEXT/);
    });
  });

  describe("the PayU settings", () => {
    it("leaves billing off without keys, and uses PayU's test hosts unless the mode is exactly live", () => {
      const off = parseServerEnv(base);
      expect([off.PAYU_MERCHANT_KEY, off.PAYU_MERCHANT_SALT, off.PAYU_MODE]).toEqual([undefined, undefined, "test"]);
      expect(parseServerEnv({ ...base, PAYU_MODE: "live" }).PAYU_MODE).toBe("live");
      expect(() => parseServerEnv({ ...base, PAYU_MODE: "production" })).toThrow(/PAYU_MODE/);
    });

    it("takes the key and salt together, and refuses one without the other, without echoing either", () => {
      expect(parseServerEnv({ ...base, PAYU_MERCHANT_KEY: "gtKFFx", PAYU_MERCHANT_SALT: "salt-123" }).PAYU_MERCHANT_KEY).toBe("gtKFFx");
      for (const only of [{ PAYU_MERCHANT_KEY: "gtKFFx" }, { PAYU_MERCHANT_SALT: "salt-123" }]) {
        try {
          parseServerEnv({ ...base, ...only });
          expect.unreachable();
        } catch (e) {
          expect((e as EnvError).message).toContain("PAYU_MERCHANT_KEY and PAYU_MERCHANT_SALT must be set together");
          expect((e as EnvError).message).not.toMatch(/gtKFFx|salt-123/);
        }
      }
    });
  });

  describe("failure injection (staging only)", () => {
    const TEST_BUSINESS = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    it("is off unless both settings are there, and takes a list of known failures for named businesses", () => {
      expect(parseServerEnv(base).FAILURE_INJECTION).toBeUndefined();
      const on = parseServerEnv({ ...base, FAILURE_INJECTION: "llm_timeout, whatsapp_send_error", FAILURE_INJECTION_TENANTS: TEST_BUSINESS });
      expect(on.FAILURE_INJECTION).toBe("llm_timeout, whatsapp_send_error");
      expect(() => parseServerEnv({ ...base, FAILURE_INJECTION: "llm_timeout" })).toThrow(/FAILURE_INJECTION and FAILURE_INJECTION_TENANTS must be set together/);
      expect(() => parseServerEnv({ ...base, FAILURE_INJECTION_TENANTS: TEST_BUSINESS })).toThrow(/must be set together/);
    });

    it("refuses an unknown failure, a business that is not an id, and live PayU", () => {
      expect(() => parseServerEnv({ ...base, FAILURE_INJECTION: "llm_timeout,db_down", FAILURE_INJECTION_TENANTS: TEST_BUSINESS })).toThrow(/FAILURE_INJECTION/);
      expect(() => parseServerEnv({ ...base, FAILURE_INJECTION: "llm_timeout", FAILURE_INJECTION_TENANTS: "all" })).toThrow(/FAILURE_INJECTION_TENANTS/);
      expect(() => parseServerEnv({ ...base, FAILURE_INJECTION: "llm_timeout", FAILURE_INJECTION_TENANTS: TEST_BUSINESS, PAYU_MODE: "live" })).toThrow(/refused with PAYU_MODE=live/);
    });
  });

  it("names the bad variable without echoing its value", () => {
    try {
      parseServerEnv({ ...base, WHATSAPP_REGISTER_PIN: "12ab-secret" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).message).toContain("WHATSAPP_REGISTER_PIN");
      expect((e as EnvError).message).not.toContain("12ab-secret");
    }
  });

  it("refuses a Postgres connection string as the Supabase URL, without echoing it", () => {
    const value = "postgresql://postgres:p%40ss@db.abcd.supabase.co:5432/postgres";
    expect(() => parseServerEnv({ ...base, NEXT_PUBLIC_SUPABASE_URL: value })).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(() => parseServerEnv({ ...base, NEXT_PUBLIC_SUPABASE_URL: value })).not.toThrow(/p%40ss/);
  });

  it("requires ENCRYPTION_KEY to be 32 bytes", () => {
    const good = randomBytes(32).toString("base64");
    const short = randomBytes(16).toString("base64");
    expect(parseServerEnv({ ...base, ENCRYPTION_KEY: good }).ENCRYPTION_KEY)
      .toBe(good);
    expect(() => parseServerEnv({ ...base, ENCRYPTION_KEY: short })).toThrow(
      /ENCRYPTION_KEY/,
    );
  });

  it("pins the Graph API version format", () => {
    expect(
      parseServerEnv({ ...base, META_GRAPH_API_VERSION: "v23.0" })
        .META_GRAPH_API_VERSION,
    ).toBe("v23.0");
    expect(() =>
      parseServerEnv({ ...base, META_GRAPH_API_VERSION: "latest" }),
    ).toThrow(/META_GRAPH_API_VERSION/);
  });
});

describe("API server settings", () => {
  it("listens on 0.0.0.0:4000 unless PORT and HOST say otherwise", () => {
    expect(parseServerEnv(base)).toMatchObject({ PORT: 4000, HOST: "0.0.0.0" });
    expect(parseServerEnv({ ...base, PORT: "8080" }).PORT).toBe(8080);
    expect(() => parseServerEnv({ ...base, PORT: "eighty" })).toThrow(/PORT/);
  });

  it("parses CORS_ALLOWED_ORIGINS into exact origins", () => {
    expect(
      parseServerEnv({ ...base, CORS_ALLOWED_ORIGINS: "https://staging.pakkaagent.in, http://localhost:3000/" })
        .CORS_ALLOWED_ORIGINS,
    ).toEqual(["https://staging.pakkaagent.in", "http://localhost:3000"]);
    expect(parseServerEnv(base).CORS_ALLOWED_ORIGINS).toBeUndefined();
  });

  it.each(["*", "https://*.vercel.app", "https://app.example.com/path", "ftp://files.example.com", "https://user:pw@app.example.com", "not a url"])(
    "refuses %j as a CORS origin",
    (bad) => {
      expect(() => parseServerEnv({ ...base, CORS_ALLOWED_ORIGINS: bad })).toThrow(/CORS_ALLOWED_ORIGINS/);
    },
  );
});

describe("PRIVACY_POLICY_URL", () => {
  it("never carries a line break or a tab into the notice: the URL parser removes them", () => {
    for (const messy of ["https://acme.example/privacy\nSTOP", "https://acme.example/\tprivacy"]) {
      const url = parseServerEnv({ ...base, PRIVACY_POLICY_URL: messy }).PRIVACY_POLICY_URL;
      expect(url).toMatch(/^https:\/\/\S+$/);
    }
  });

  it("defaults to the product's privacy page when unset or empty", () => {
    expect(parseServerEnv(base).PRIVACY_POLICY_URL).toBe("https://pakkaagent.in/privacy");
    expect(parseServerEnv({ ...base, PRIVACY_POLICY_URL: "" }).PRIVACY_POLICY_URL).toBe("https://pakkaagent.in/privacy");
  });

  it("keeps an explicit https URL", () => {
    expect(parseServerEnv({ ...base, PRIVACY_POLICY_URL: "https://acme.example/privacy" }).PRIVACY_POLICY_URL).toBe("https://acme.example/privacy");
  });

  it.each([
    "http://acme.example/privacy",
    "acme.example/privacy",
    "javascript:alert(1)",
    "not a url",
    "https://acme.example/pri vacy",
    `https://acme.example/${"a".repeat(300)}`,
  ])("rejects %j: it goes to customers", (bad) => {
    expect(() => parseServerEnv({ ...base, PRIVACY_POLICY_URL: bad })).toThrow(/PRIVACY_POLICY_URL/);
  });
});

describe("META_GRAPH_API_VERSION default", () => {
  it("defaults to v26.0 when unset or empty", () => {
    expect(parseServerEnv(base).META_GRAPH_API_VERSION).toBe("v26.0");
    expect(
      parseServerEnv({ ...base, META_GRAPH_API_VERSION: "" }).META_GRAPH_API_VERSION,
    ).toBe("v26.0");
  });

  it("keeps an explicit version", () => {
    expect(
      parseServerEnv({ ...base, META_GRAPH_API_VERSION: "v27.0" }).META_GRAPH_API_VERSION,
    ).toBe("v27.0");
  });

  it.each(["latest", "26.0", " v26.0", "v26"])("still rejects %j", (bad) => {
    expect(() => parseServerEnv({ ...base, META_GRAPH_API_VERSION: bad })).toThrow(
      /META_GRAPH_API_VERSION/,
    );
  });
});

describe("embeddings settings", () => {
  it("defaults to the Atlas endpoint for Voyage models and voyage-4", () => {
    const env = parseServerEnv(base);
    expect(env.EMBEDDINGS_BASE_URL).toBe("https://ai.mongodb.com/v1");
    expect(env.EMBEDDINGS_MODEL).toBe("voyage-4");
  });

  it("accepts a Voyage-direct endpoint and rejects a base URL that isn't a URL", () => {
    expect(parseServerEnv({ ...base, EMBEDDINGS_BASE_URL: "https://api.voyageai.com/v1" }).EMBEDDINGS_BASE_URL).toBe("https://api.voyageai.com/v1");
    expect(() => parseServerEnv({ ...base, EMBEDDINGS_BASE_URL: "not a url" })).toThrow(/EMBEDDINGS_BASE_URL/);
  });

  it("requires https for the embeddings endpoint, since the key travels to it", () => {
    for (const url of ["http://api.voyageai.com/v1", "http://localhost:9000/v1", "ftp://x.test/v1"]) {
      expect(() => parseServerEnv({ ...base, EMBEDDINGS_BASE_URL: url })).toThrow(/EMBEDDINGS_BASE_URL/);
    }
  });

  it("requires EMBEDDINGS_API_KEY, naming it without echoing anything", () => {
    const withoutKey: Record<string, string | undefined> = { ...base, EMBEDDINGS_API_KEY: undefined };
    expect(() => parseServerEnv(withoutKey)).toThrow(/EMBEDDINGS_API_KEY/);
    expect(() => parseServerEnv({ ...base, EMBEDDINGS_API_KEY: "" })).toThrow(/EMBEDDINGS_API_KEY/);
    try {
      parseServerEnv(withoutKey);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).problems).toHaveLength(1);
    }
  });
});

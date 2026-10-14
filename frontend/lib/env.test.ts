import { describe, expect, it } from "vitest";
import { parseApiUrl, parseDemoWhatsAppNumber, parseMetaSignupEnv, parsePublicEnv, parseSetupCallUrl } from "./env";

describe("parseApiUrl", () => {
  it("accepts the API's origin, with or without a trailing slash", () => {
    expect(parseApiUrl("https://api.pakkaagent.in")).toBe("https://api.pakkaagent.in");
    expect(parseApiUrl("http://localhost:4000/")).toBe("http://localhost:4000");
  });

  it.each([undefined, "", "api.example.test", "https://api.example.test/api", "ftp://api.example.test", "https://user:pw@api.example.test"])(
    "refuses %j, naming the variable but not the value",
    (value) => {
      expect(() => parseApiUrl(value)).toThrow(/NEXT_PUBLIC_API_URL/);
      if (value) expect(() => parseApiUrl(value)).not.toThrow(value);
    },
  );
});

describe("parsePublicEnv", () => {
  it("accepts the project's https API URL and anon key", () => {
    expect(parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" })).toEqual({
      url: "https://abcd.supabase.co",
      anonKey: "anon",
    });
  });

  it("rejects a Postgres connection string without echoing it", () => {
    const value = "postgresql://postgres:p%40ss@db.abcd.supabase.co:5432/postgres";
    let message = "";
    try {
      parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: value, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(message).not.toContain("p%40ss");
    expect(message).not.toContain("postgres:");
  });

  it("rejects URLs with credentials and missing keys", () => {
    expect(() => parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://user:pw@abcd.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" })).toThrow(/credentials/);
    expect(() => parsePublicEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co" })).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });
});

describe("parseMetaSignupEnv", () => {
  it("is ready with both numeric ids", () => {
    expect(parseMetaSignupEnv({ NEXT_PUBLIC_META_APP_ID: " 1234567890 ", NEXT_PUBLIC_META_ES_CONFIG_ID: "987654321" })).toEqual({
      status: "ready",
      appId: "1234567890",
      configId: "987654321",
    });
  });

  it("stays off, naming each missing variable, when either is unset", () => {
    expect(parseMetaSignupEnv({})).toEqual({
      status: "off",
      problems: ["NEXT_PUBLIC_META_APP_ID is not set", "NEXT_PUBLIC_META_ES_CONFIG_ID is not set"],
    });
    expect(parseMetaSignupEnv({ NEXT_PUBLIC_META_APP_ID: "1", NEXT_PUBLIC_META_ES_CONFIG_ID: "" }).status).toBe("off");
  });

  it("stays off for a malformed id without echoing it", () => {
    const result = parseMetaSignupEnv({ NEXT_PUBLIC_META_APP_ID: "app-secret-ish", NEXT_PUBLIC_META_ES_CONFIG_ID: "2" });
    expect(result).toEqual({ status: "off", problems: ["NEXT_PUBLIC_META_APP_ID must be a numeric id"] });
    expect(JSON.stringify(result)).not.toContain("app-secret-ish");
  });
});

describe("parseSetupCallUrl", () => {
  it("accepts an https address and returns it normalised", () => {
    expect(parseSetupCallUrl("https://cal.example.com/spark/setup")).toBe("https://cal.example.com/spark/setup");
    expect(parseSetupCallUrl("  https://cal.example.com  ")).toBe("https://cal.example.com/");
  });
  it("is null when unset, blank, not https or not an address, so the page falls back to its text instead of a dead button", () => {
    for (const bad of [undefined, "", "   ", "http://cal.example.com", "javascript:alert(1)", "cal.example.com", "ftp://x.test"]) {
      expect(parseSetupCallUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe("parseDemoWhatsAppNumber", () => {
  it("keeps the digits of a valid number and drops the formatting", () => {
    expect(parseDemoWhatsAppNumber("919812345678")).toBe("919812345678");
    expect(parseDemoWhatsAppNumber(" +91 98123-45678 ")).toBe("919812345678");
  });

  it("is null when unset, blank, not a number, too short or too long, or starts with 0", () => {
    for (const bad of [undefined, "", "   ", "abc", "91981234567x", "12345", "0981234567890", "1234567890123456", "wa.me/919812345678", "++919812345678"]) {
      expect(parseDemoWhatsAppNumber(bad), String(bad)).toBeNull();
    }
  });
});

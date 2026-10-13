import { CreateTemplateInput } from "@pakka/types";
import { describe, expect, it } from "vitest";
import { ApiError, apiErrorFrom, formatError } from "./errors";

describe("formatError", () => {
  it("shows our API's message with a title for its code", () => {
    const err = new ApiError(409, {
      error: { code: "whatsapp_not_connected", message: "This business has no connected WhatsApp number yet." },
    });
    expect(formatError(err)).toEqual({
      code: "whatsapp_not_connected",
      title: "WhatsApp isn't connected",
      message: "This business has no connected WhatsApp number yet.",
      retryable: false,
    });
  });

  it.each([
    ["outside_window", "Outside the 24-hour window"],
    ["conflict", "That already exists"],
    ["rate_limited", "Too many requests"],
    ["insufficient_credits", "Not enough credits"],
    ["slot_taken", "That slot is taken"],
    ["plan_required", "Not on your plan"],
    ["seat_limit", "No seats left"],
  ] as const)("gives the agreed code %s a title and keeps the API's message", (code, title) => {
    const formatted = formatError(new ApiError(409, { error: { code, message: "Pick another time." } }));
    expect(formatted).toMatchObject({ code, title, message: "Pick another time." });
  });

  it("keeps field errors from a validation response", () => {
    const err = new ApiError(422, { error: { code: "validation_failed", message: "Check the highlighted fields.", fields: { to: "Bad number" } } });
    expect(formatError(err)).toMatchObject({ code: "validation_failed", fields: { to: "Bad number" }, retryable: false });
  });

  it("drops an API message that looks like it contains a credential", () => {
    const err = new ApiError(500, { error: { code: "internal", message: "failed: postgresql://postgres:pw@db.x.supabase.co/postgres" } });
    const f = formatError(err);
    expect(f.message).toBe("Something went wrong. Try again in a moment.");
    expect(JSON.stringify(f)).not.toContain("pw@");
  });

  it("maps Supabase Auth errors to fixed copy", () => {
    const authErr = { __isAuthError: true, name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" };
    expect(formatError(authErr)).toMatchObject({ code: "auth", message: "Email or password is incorrect.", retryable: false });
    const unknownAuth = { __isAuthError: true, name: "AuthRetryableFetchError", status: 0, code: undefined, message: "fetch failed at https://x.supabase.co" };
    const f = formatError(unknownAuth);
    expect(f.message).toBe("We couldn't sign you in. Try again in a moment.");
    expect(f.message).not.toContain("supabase.co");
  });

  it("maps Supabase signup errors to fixed copy", () => {
    const weak = { __isAuthError: true, name: "AuthWeakPasswordError", status: 422, code: "weak_password", message: "Password is known to be weak and easy to guess" };
    expect(formatError(weak)).toMatchObject({ code: "auth", message: "Choose a stronger password: longer, and not one you use elsewhere.", retryable: false });
    const disabled = { __isAuthError: true, name: "AuthApiError", status: 422, code: "signup_disabled", message: "Signups not allowed for this instance" };
    expect(formatError(disabled).message).toBe("New accounts can't be created right now. Try again later.");
  });

  it("never shows PostgREST error details", () => {
    const pg = { code: "42501", message: 'permission denied for table "tenants"', details: "secret detail", hint: null };
    const f = formatError(pg);
    // 42501 (insufficient privilege / RLS) is a permission answer, not an outage: not retryable. The database text still never shows.
    expect(f).toMatchObject({ code: "forbidden", retryable: false });
    expect(JSON.stringify(f)).not.toMatch(/permission denied|tenants|secret detail/);
  });

  it("turns Zod errors into field messages", () => {
    const parsed = CreateTemplateInput.safeParse({ name: "Bad Name", category: "utility", language: "en", body: "Hi {{1}}", examples: [] });
    const f = formatError(parsed.error);
    expect(f.code).toBe("validation_failed");
    expect(f.fields?.name).toMatch(/lowercase/);
    expect(f.fields?.examples).toMatch(/sample/);
  });

  it("reports network failures as retryable", () => {
    expect(formatError(new TypeError("Failed to fetch"))).toMatchObject({ code: "network", retryable: true });
  });

  it("hides unknown errors and their stack", () => {
    const err = new Error("TypeError: cannot read x of undefined\n    at secret.ts:12");
    const f = formatError(err);
    expect(f).toEqual({ code: "internal", title: "Something went wrong", message: "Something went wrong. Try again in a moment.", retryable: true });
    expect(formatError("boom").code).toBe("internal");
    expect(formatError(null).code).toBe("internal");
  });
});

describe("apiErrorFrom", () => {
  it("parses the error envelope", async () => {
    const res = new Response(JSON.stringify({ error: { code: "forbidden", message: "Only an owner or admin can do that." } }), { status: 403 });
    const err = await apiErrorFrom(res);
    expect(err.status).toBe(403);
    expect(err.body.error.code).toBe("forbidden");
  });

  it("falls back to a generic error for non-envelope bodies", async () => {
    const err = await apiErrorFrom(new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(err.body.error).toEqual({ code: "internal", message: "Something went wrong. Try again in a moment." });
  });

  it("words a row-level-security refusal as a permission message, without the database's text", () => {
    const refused = { code: "42501", message: 'new row violates row-level security policy for table "services"', details: null, hint: null };
    const formatted = formatError(refused);
    expect(formatted).toMatchObject({ code: "forbidden", title: "You don't have access to this", retryable: false });
    expect(formatted.message).toBe("Only an owner or admin can change this. Nothing was changed.");
    expect(formatted.message).not.toMatch(/row-level|services/);
  });
});

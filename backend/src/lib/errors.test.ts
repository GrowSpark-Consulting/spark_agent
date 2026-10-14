import { redactSecrets } from "@pakka/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, errorKind, toErrorResponse } from "./errors";
import { redactForLog } from "./redact";

describe("toErrorResponse", () => {
  it("passes an AppError's code, safe message and status through", () => {
    const res = toErrorResponse(new AppError("forbidden", "Only an owner or admin can do that."));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden", message: "Only an owner or admin can do that." } });
  });

  it.each([
    ["outside_window", 409],
    ["conflict", 409],
    ["rate_limited", 429],
    ["insufficient_credits", 402],
    ["slot_taken", 409],
    ["plan_required", 403],
    ["seat_limit", 409],
  ] as const)("answers %s with HTTP %i", (code, status) => {
    const res = toErrorResponse(new AppError(code, "Safe message."));
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: { code, message: "Safe message." } });
  });

  it("turns a Zod error into validation_failed with one message per field", () => {
    const err = z.object({ to: z.string().min(3, "too short"), body: z.string() }).safeParse({ to: "1" }).error;
    const res = toErrorResponse(err);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_failed");
    expect(res.body.error.fields).toMatchObject({ to: "too short" });
    expect(res.body.error.fields?.body).toBeTruthy();
  });

  it("hides unknown errors from the user, and logs only what kind of error it was, never its message (Day 7 log sweep)", () => {
    const logs: string[] = [];
    const secret = "connect to postgresql://postgres:hunter2@db.example.supabase.co:5432/postgres failed for +919840012345: 'my address is 12 Gandhi St'";
    const res = toErrorResponse(new Error(secret), (l) => logs.push(l));
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: "internal", message: "Something went wrong on our side. Try again in a moment." });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
    expect(logs).toEqual(["[api] unexpected error: Error"]);
  });

  it("names an error by its name and a short code, never its message", () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "contacts_tenant_id_phone_key": Key (tenant_id, phone)=(x, +919840012345)'), { code: "23505" });
    expect(errorKind(pg)).toBe("Error (23505)");
    expect(errorKind(new TypeError("Cannot read properties of undefined (reading 'phone')"))).toBe("TypeError");
    expect(errorKind(Object.assign(new Error("x"), { code: "a code with spaces and +919840012345" }))).toBe("Error");
    expect(errorKind("a string a library threw, with +919840012345")).toBe("a thrown string");
    expect(errorKind(null)).toBe("a thrown null");
  });

  it("handles thrown non-errors", () => {
    const res = toErrorResponse("boom", () => {});
    expect(res.body.error.code).toBe("internal");
  });
});

// Fake credential-shaped strings, assembled at runtime so secret scanners don't flag this file.
const fake = (...parts: string[]) => parts.join("");

describe("redactSecrets", () => {
  it.each([
    ["postgresql://postgres:p%40ss@db.x.supabase.co:5432/postgres", "p%40ss"],
    [fake("key sb_", "secret_abcDEF123456"), fake("sb_", "secret_abcDEF123456")],
    [fake("anon sb_", "publishable_abc123"), fake("sb_", "publishable_abc123")],
    [fake("token ey", "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc"), fake("ey", "JhbGciOiJIUzI1NiJ9")],
    [fake("meta EA", "AGm0PX4ZCpsBAKZCZBZBabcdefghij"), fake("EA", "AGm0PX4ZCpsBAKZCZBZBabcdefghij")],
    ["Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    // Day 7 log sweep: an Anthropic key, and any other run of 32+ key characters (a connect-link or hand-over token, an app secret).
    [fake("model key sk-", "ant-api03-AbCdEf_123"), fake("sk-", "ant-api03-AbCdEf_123")],
    ["link token 7Hk2_mQ9xLp4Rt8Vb1Nc6Zd3Fg5Js0Wy-aE in a message", "7Hk2_mQ9xLp4Rt8Vb1Nc6Zd3Fg5Js0Wy-aE"],
    ["app secret 0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"],
  ])("removes %s", (text, secret) => {
    expect(redactSecrets(text)).not.toContain(secret);
  });

  it("leaves ordinary text alone, a UUID included (what the dashboard shows depends on it: a phone number is not a credential)", () => {
    expect(redactSecrets("Template reminder_24h_v1 sent to +919840012345")).toBe(
      "Template reminder_24h_v1 sent to +919840012345",
    );
    expect(redactSecrets("booking 9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b not found")).toBe("booking 9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b not found");
  });
});

describe("redactForLog", () => {
  it("also masks phone numbers and emails, for log lines only", () => {
    const line = redactForLog("refund for +919840012345 (asha@example.com) failed: Bearer abc.def.ghi");
    expect(line).not.toMatch(/9840012345|asha@example\.com|abc\.def\.ghi/);
    expect(line).toContain("failed");
  });
});

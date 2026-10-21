import { WEBSITE_IMPORT_LIMITS } from "@pakka/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";
import { KbDataError, KbUnavailableError } from "./kb-content";

const postJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ postJson: (...a: unknown[]) => postJson(...a) }));

const { describeImportFailure, EMPTY_ADDRESS, IMPORT_FAILED_FALLBACK, IMPORT_NOTE, ImportAddressError, importProgress, importWebsite, SLOW_AFTER_MS, validateImportUrl } = await import("./website-import");

// The answer is typed as the shared contract (packages/types/src/kb-import.ts, task note 2026-10-15-feat-kb-website-import.md). These tests stand in
// for the API: they prove what is sent and how each answer reads, not that the real route or its network fetch work.

const TENANT = "10000000-0000-0000-0000-000000000004";
const ID = "30000000-0000-4000-8000-000000000001";
const accepted = (over: Record<string, unknown> = {}) => ({ id: ID, title: "About us", sourceType: "website", sourceUrl: "https://www.example.com/about", status: "processing", createdAt: "2026-10-15T10:00:00.000Z", replaced: false, ...over });
const apiError = (status: number, code: string, message: string, fields?: Record<string, string>) => new ApiError(status, { error: { code, message, ...(fields && { fields }) } } as never);

beforeEach(() => {
  postJson.mockReset();
});

describe("importWebsite", () => {
  it("sends { url } and nothing else, to the documented path, for the business", async () => {
    postJson.mockResolvedValue(accepted());
    await importWebsite(TENANT, "  https://www.example.com/about ");
    expect(postJson).toHaveBeenCalledWith("/api/onboarding/import-site", { url: "https://www.example.com/about" }, { tenantId: TENANT });
  });

  it("sends no business header when the wizard does not know it (the API then uses the account's only business)", async () => {
    postJson.mockResolvedValue(accepted());
    await importWebsite(undefined, "https://www.example.com/about");
    expect(postJson.mock.calls[0][2]).toEqual({});
  });

  it("returns the page as a processing document in the list's own shape", async () => {
    postJson.mockResolvedValue(accepted());
    const { document, replaced } = await importWebsite(TENANT, "https://www.example.com/about");
    expect(replaced).toBe(false);
    expect(document).toMatchObject({ id: ID, name: "About us", label: "WEB", sourceType: "website", status: "processing", error: null });
  });

  it("says a re-import replaced the earlier one, with the same id so the list holds one row", async () => {
    postJson.mockResolvedValue(accepted({ replaced: true }));
    const { document, replaced } = await importWebsite(TENANT, "https://www.example.com/about");
    expect(replaced).toBe(true);
    expect(document.id).toBe(ID);
  });

  it("sends nothing for an empty address", async () => {
    for (const bad of ["", "   "]) await expect(importWebsite(TENANT, bad)).rejects.toBeInstanceOf(ImportAddressError);
    expect(postJson).not.toHaveBeenCalled();
  });

  it("does not take an answer that is not the contract's shape for an import", async () => {
    for (const bad of [{ ...accepted(), status: "ready" }, { ...accepted(), sourceType: "upload" }, { id: ID }, null, "ok"]) {
      postJson.mockResolvedValueOnce(bad);
      await expect(importWebsite(TENANT, "https://www.example.com/about")).rejects.toBeInstanceOf(KbDataError);
    }
  });

  it("says the service is not deployed when the route is missing (404 or 501), and passes every other refusal on", async () => {
    postJson.mockRejectedValueOnce(apiError(404, "not_found", "Not found."));
    await expect(importWebsite(TENANT, "https://x.example/")).rejects.toBeInstanceOf(KbUnavailableError);
    postJson.mockRejectedValueOnce(apiError(501, "not_available", "Not available."));
    await expect(importWebsite(TENANT, "https://x.example/")).rejects.toBeInstanceOf(KbUnavailableError);
    postJson.mockRejectedValueOnce(apiError(422, "validation_failed", "Check the address and try again.", { url: "x" }));
    await expect(importWebsite(TENANT, "https://x.example/")).rejects.toBeInstanceOf(ApiError);
  });

  it("limits come from the shared contract", () => {
    expect(WEBSITE_IMPORT_LIMITS).toMatchObject({ maxPageBytes: 2 * 1024 * 1024, timeoutSeconds: 15, maxRedirects: 3, importsPerHour: 20 });
  });
});

describe("the address box", () => {
  it("only checks that something was typed; the server decides what is allowed", () => {
    expect(validateImportUrl("")).toBe(EMPTY_ADDRESS);
    expect(validateImportUrl("   ")).toBe(EMPTY_ADDRESS);
    expect(validateImportUrl("https://www.example.com/about")).toBeNull();
    expect(validateImportUrl("http://192.168.0.1/")).toBeNull();
    expect(validateImportUrl("x".repeat(2001))).toBe(EMPTY_ADDRESS);
  });
});

describe("how each refusal reads (the API's messages are shown as written)", () => {
  const SESSION = "Your session has ended. Sign in again.";
  it("401: the session message, as a notice", () => {
    const f = describeImportFailure(apiError(401, "unauthenticated", SESSION));
    expect(f.address).toBeNull();
    expect(f.notice?.message).toBe(SESSION);
  });

  it("403 for staff: the role message, as a notice", () => {
    const f = describeImportFailure(apiError(403, "forbidden", "Only an owner or admin can import a web page."));
    expect(f.notice?.message).toBe("Only an owner or admin can import a web page.");
  });

  it("422 about the address: the message goes under the address box and nowhere else", () => {
    const text = "That address isn't allowed: it points to a private or internal network. Use your website's public address.";
    const f = describeImportFailure(apiError(422, "validation_failed", text, { url: text }));
    expect(f.address).toBe(text);
    expect(f.notice).toBeNull();
  });

  it("422 that is not about the address (the 100-document limit) is a notice, not an address error", () => {
    const text = "You can keep up to 100 documents. Delete one you no longer need, then import again.";
    const f = describeImportFailure(apiError(422, "validation_failed", text));
    expect(f.address).toBeNull();
    expect(f.notice?.message).toBe(text);
  });

  it("409 (still processing), 429 (too many) and 502 (could not open) keep the API's words", () => {
    expect(describeImportFailure(apiError(409, "conflict", "This page is still being processed from the last import. Try again in a minute.")).notice?.message).toMatch(/still being processed/);
    expect(describeImportFailure(apiError(429, "rate_limited", "You've imported a lot of pages in the last hour. Try again later.")).notice?.message).toMatch(/last hour/);
    expect(describeImportFailure(apiError(502, "upstream_failed", "We couldn't open that page. Check the address and that the site is online, then try again.")).notice?.message).toMatch(/couldn't open/);
  });

  it("500 and a lost connection give a safe message, never the raw error", () => {
    const f = describeImportFailure(apiError(500, "internal", "Something went wrong on our side. Try again in a moment."));
    expect(f.notice?.message).toMatch(/Something went wrong/);
    const net = describeImportFailure(new TypeError("fetch failed: ECONNREFUSED 10.0.0.5:4000"));
    expect(net.notice?.message).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });

  it("an empty address, a missing service and an unreadable answer each get their own words", () => {
    expect(describeImportFailure(new ImportAddressError()).address).toBe(EMPTY_ADDRESS);
    expect(describeImportFailure(new KbUnavailableError()).notice?.code).toBe("not_available");
    const unreadable = describeImportFailure(new KbDataError("website import"));
    expect(unreadable.notice?.message).toMatch(/documents list/);
    expect(unreadable.notice?.message).not.toMatch(/nothing was|not imported/i);
  });
});

describe("what the page's document is doing", () => {
  it("is processing until its own row says otherwise, including before the list shows the row", () => {
    expect(importProgress(undefined, 0).kind).toBe("processing");
    expect(importProgress({ status: "processing", error: null }, 5_000).kind).toBe("processing");
  });

  it("is slow only after about two minutes, and only while still processing", () => {
    expect(importProgress({ status: "processing", error: null }, SLOW_AFTER_MS - 1).kind).toBe("processing");
    expect(importProgress({ status: "processing", error: null }, SLOW_AFTER_MS).kind).toBe("slow");
    expect(importProgress({ status: "ready", error: null }, SLOW_AFTER_MS * 5).kind).toBe("ready");
  });

  it("is ready only from the row, never from the 202", () => {
    expect(importProgress({ status: "ready", error: null }, 0)).toMatchObject({ kind: "ready" });
  });

  it("shows a failed page's reason as the server wrote it, or a fallback", () => {
    expect(importProgress({ status: "failed", error: "This file has no readable text." }, 0)).toEqual({ kind: "failed", text: "This file has no readable text." });
    expect(importProgress({ status: "failed", error: null }, 0).text).toBe(IMPORT_FAILED_FALLBACK);
  });

  it("the note says pages are searchable once processed and that there is no review step", () => {
    expect(IMPORT_NOTE).toMatch(/processed/);
    expect(IMPORT_NOTE).toMatch(/no review step/);
    expect(IMPORT_NOTE).toMatch(/replaces/);
    expect(IMPORT_NOTE).toMatch(/no credits/);
  });
});

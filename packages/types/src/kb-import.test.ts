import { describe, expect, it } from "vitest";
import { ImportedWebsite, ImportSiteRequest, WEBSITE_IMPORT_LIMITS, type ImportedWebsite as ImportedWebsiteType } from "./kb-import";

// POST /api/onboarding/import-site (backend/src/kb/website.ts): the body the screen sends and the answer it gets. The backend types its answer with
// ImportedWebsite and parses the body with ImportSiteRequest, so the two cannot drift.

describe("ImportSiteRequest, the body", () => {
  it("is one url", () => {
    expect(ImportSiteRequest.parse({ url: "https://www.example.com/about" })).toEqual({ url: "https://www.example.com/about" });
  });

  it("trims the address", () => {
    expect(ImportSiteRequest.parse({ url: "  https://example.com/  " }).url).toBe("https://example.com/");
  });

  it.each([
    ["no url", {}],
    ["an empty url", { url: "" }],
    ["a blank url", { url: "   " }],
    ["a url that is not text", { url: 5 }],
    ["a url over 2,000 characters", { url: `https://example.com/${"a".repeat(2000)}` }],
    ["a business named in the body", { url: "https://example.com", tenantId: "e0000000-0000-4000-8000-00000000000a" }],
    ["a second page", { url: "https://example.com", urls: ["https://example.com/b"] }],
    ["not an object", "https://example.com"],
    ["null", null],
  ])("refuses %s", (_name, body) => {
    expect(ImportSiteRequest.safeParse(body).success).toBe(false);
  });
});

describe("ImportedWebsite, the answer", () => {
  const answer: ImportedWebsiteType = {
    id: "d1000000-0000-4000-8000-000000000001",
    title: "About us",
    sourceType: "website",
    sourceUrl: "https://www.example.com/about",
    status: "processing",
    createdAt: "2026-10-15T10:00:00.000Z",
    replaced: false,
  };

  it("is a website document that is processing, with whether it replaced an earlier import of the same address", () => {
    expect(ImportedWebsite.parse(answer)).toEqual(answer);
    expect(ImportedWebsite.parse({ ...answer, replaced: true }).replaced).toBe(true);
  });

  it.each([
    ["an upload", { sourceType: "upload" }],
    ["a status that is not processing", { status: "ready" }],
    ["no source address", { sourceUrl: undefined }],
    ["no replaced flag", { replaced: undefined }],
  ])("refuses %s", (_name, change) => {
    expect(ImportedWebsite.safeParse({ ...answer, ...change }).success).toBe(false);
  });
});

describe("the limits the screen can mention", () => {
  it("are 2 MB, 15 seconds, 3 redirects and 20 imports an hour", () => {
    expect(WEBSITE_IMPORT_LIMITS).toEqual({ maxPageBytes: 2 * 1024 * 1024, timeoutSeconds: 15, maxRedirects: 3, importsPerHour: 20 });
  });
});

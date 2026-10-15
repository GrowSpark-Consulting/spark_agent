import type { TenantContext } from "@pakka/types";
import { ImportedWebsite } from "@pakka/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../lib/audit";
import { AppError } from "../lib/errors";
import { TimeoutError } from "../lib/timeout";
import { fakeKbStore } from "../test-support/fake-kb-store";
import { MAX_CHUNKS } from "./chunk";
import { KB_UPLOAD_EVENT, kbWebsiteEventId } from "./events";
import { PageFetchError } from "./fetch-page";
import { MAX_DOCUMENTS } from "./documents";
import { importWebsite, IMPORT_MESSAGES, MIN_PAGE_CHARS, type WebsiteDeps } from "./website";

// POST /api/onboarding/import-site: one web page into the knowledge base as a document (`website`). The page is fetched safely (fetch-page.ts), read (html-text.ts),
// stored as a `processing` document with its text, and the same ingest job as an upload chunks and embeds it. Importing the same address again replaces that page's
// earlier content. No page is fetched, no model is called and no database is reached here: the page, the store, the event and the audit are fakes.

const A = "e0000000-0000-4000-8000-00000000000a";
const B = "e0000000-0000-4000-8000-00000000000b";
const USER = "f1000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-15T10:00:00.000Z");

const context = (role: TenantContext["role"] = "owner", tenantId = A): TenantContext => ({
  user: { id: USER, email: "owner@example.com" },
  role,
  tenant: { id: tenantId, name: "Sunrise Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "growth", trialEndsAt: null },
});

const sentence = (n: number) => Array.from({ length: n }, (_, i) => `Skyline Towers has homes ready to move in, number ${i + 1}.`).join(" ");
const pageHtml = (body = `<h1>About Skyline Towers</h1><p>${sentence(8)}</p>`, head = "<title>About us | Sunrise Homes</title>") => `<!doctype html><html><head>${head}</head><body><main>${body}</main></body></html>`;

function world(over: { html?: string; fail?: PageFetchError | Error; docs?: Parameters<typeof fakeKbStore>[0]; recentImports?: number; sendError?: Error; finalUrl?: string } = {}) {
  const kb = fakeKbStore(over.docs ?? []);
  kb.state.recentImports = over.recentImports ?? 0;
  const fetched: string[] = [];
  const events: { id: string; name: string; data: { tenantId: string; documentId: string } }[] = [];
  const audits: AuditEntry[] = [];
  const clock = { now: NOW };
  const deps: WebsiteDeps = {
    store: kb.store,
    fetchPage: vi.fn(async (url: URL) => {
      fetched.push(url.href);
      if (over.fail) throw over.fail;
      return { finalUrl: new URL(over.finalUrl ?? url.href), html: over.html ?? pageHtml() };
    }),
    send: vi.fn(async (event) => {
      if (over.sendError) throw over.sendError;
      events.push(event);
    }),
    audit: vi.fn(async (entry: AuditEntry) => {
      audits.push(entry);
    }),
    now: () => clock.now,
  };
  return { ...kb, docs: () => [...kb.docs.values()], deps, fetched, events, audits, clock };
}

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("who may import", () => {
  it.each(["owner", "admin"] as const)("an %s may", async (role) => {
    const w = world();
    const result = await importWebsite(context(role), { url: "https://www.example.com/about" }, w.deps);
    expect(ImportedWebsite.safeParse(result).success).toBe(true);
  });

  it("staff may not: forbidden, naming an owner or admin, before anything is read, fetched or stored", async () => {
    const w = world();
    const error = await failure(importWebsite(context("staff"), { url: "https://www.example.com/about" }, w.deps));
    expect(error.code).toBe("forbidden");
    expect(error.message).toMatch(/^Only an owner or admin can /);
    expect(w.fetched).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(w.events).toEqual([]);
  });
});

describe("the body", () => {
  it.each([
    [{}, "url"],
    [{ url: "" }, "url"],
    [{ url: 5 }, "url"],
    [{ url: "https://example.com", tenantId: B }, "tenantId"],
    [{ url: "https://example.com", urls: ["https://example.com/b"] }, "urls"],
  ])("refuses %j with a field error on %s", async (body, field) => {
    const w = world();
    const error = await failure(importWebsite(context(), body, w.deps));
    expect(error.code).toBe("validation_failed");
    expect(error.fields).toHaveProperty(field);
    expect(w.fetched).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it.each([null, [], "https://example.com", 7])("refuses a body that is not an object (%j)", async (body) => {
    const w = world();
    expect((await failure(importWebsite(context(), body, w.deps))).code).toBe("validation_failed");
    expect(w.fetched).toEqual([]);
  });
});

describe("an address that may not be asked for", () => {
  it.each([
    ["not an address", "www.example.com/about", "invalid"],
    ["a word", "hello", "invalid"],
    ["ftp", "ftp://example.com/file", "scheme"],
    ["a file", "file:///etc/passwd", "scheme"],
    ["javascript", "javascript:alert(1)", "scheme"],
    ["a password", "https://user:secret@example.com/", "credentials"],
    ["a special port", "https://example.com:8080/", "port"],
    ["localhost", "http://localhost/", "blocked"],
    ["a loopback address", "http://127.0.0.1/", "blocked"],
    ["a numeric loopback address", "http://2130706433/", "blocked"],
    ["a private address", "http://192.168.1.10/", "blocked"],
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/", "blocked"],
    ["an internal name", "http://db.railway.internal/", "blocked"],
    ["an IPv6 loopback address", "http://[::1]/", "blocked"],
    ["an IPv4-mapped IPv6 address", "http://[::ffff:10.0.0.1]/", "blocked"],
    ["a name with no dot", "http://intranet/", "blocked"],
  ] as const)("%s: a field error in plain words, and nothing is fetched or stored", async (_name, url, problem) => {
    const w = world();
    const error = await failure(importWebsite(context(), { url }, w.deps));
    expect(error.code).toBe("validation_failed");
    expect(error.fields?.url).toBe(IMPORT_MESSAGES[problem]);
    expect(error.message).toBe(IMPORT_MESSAGES[problem]);
    expect(w.fetched).toEqual([]);
    expect(w.calls.filter((c) => c.startsWith("insert") || c.startsWith("replace"))).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it("the words say what to do, and never name the address that was refused", () => {
    expect(IMPORT_MESSAGES.blocked).toMatch(/public address/i);
    for (const message of Object.values(IMPORT_MESSAGES)) expect(message).not.toMatch(/169\.254|127\.0\.0\.1|localhost/);
  });
});

describe("a page that could not be read", () => {
  it.each([
    ["blocked after a redirect", new PageFetchError("blocked"), "validation_failed", IMPORT_MESSAGES.blocked],
    ["not reachable", new PageFetchError("unreachable"), "upstream_failed", IMPORT_MESSAGES.unreachable],
    ["too slow", new PageFetchError("timeout"), "upstream_failed", IMPORT_MESSAGES.timeout],
    ["a 404", new PageFetchError("status", 404), "validation_failed", "That page answered with an error (404). Check the address, or make sure the page is public."],
    ["a 403", new PageFetchError("status", 403), "validation_failed", "That page answered with an error (403). Check the address, or make sure the page is public."],
    ["a 410", new PageFetchError("status", 410), "validation_failed", "That page answered with an error (410). Check the address, or make sure the page is public."],
    ["a 500", new PageFetchError("status", 500), "upstream_failed", "That site answered with an error (500). Try again in a moment."],
    ["a 503", new PageFetchError("status", 503), "upstream_failed", "That site answered with an error (503). Try again in a moment."],
    ["a 429", new PageFetchError("status", 429), "upstream_failed", "That site answered with an error (429). Try again in a moment."],
    ["not a web page", new PageFetchError("not_html"), "validation_failed", IMPORT_MESSAGES.not_html],
    ["too large", new PageFetchError("too_large"), "validation_failed", IMPORT_MESSAGES.too_large],
    ["too many redirects", new PageFetchError("redirects"), "validation_failed", IMPORT_MESSAGES.redirects],
  ] as const)("%s: %s, in words for the owner, and nothing is stored or started", async (_name, thrown, code, message) => {
    const w = world({ fail: thrown });
    const error = await failure(importWebsite(context(), { url: "https://www.example.com/about" }, w.deps));
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    if (code === "validation_failed") expect(error.fields?.url).toBe(message);
    expect(w.calls.filter((c) => c.startsWith("insert") || c.startsWith("replace"))).toEqual([]);
    expect(w.events).toEqual([]);
    expect(w.audits).toEqual([]);
  });

  it("an unexpected failure of the fetch is 'could not open', without its own words", async () => {
    const w = world({ fail: new Error("connect ECONNREFUSED 10.0.0.1:443 internal-host") });
    const error = await failure(importWebsite(context(), { url: "https://www.example.com/about" }, w.deps));
    expect(error.code).toBe("upstream_failed");
    expect(error.message).not.toMatch(/10\.0\.0\.1|internal-host/);
  });

  it("the words for too large mention the limit", () => {
    expect(IMPORT_MESSAGES.too_large).toMatch(/2 MB/);
  });
});

describe("a page with nothing to learn from", () => {
  it("an empty page, or one with very little text, is refused in plain words", async () => {
    expect(MIN_PAGE_CHARS).toBeGreaterThanOrEqual(100);
    for (const html of ["", "<html><body></body></html>", pageHtml("<p>Coming soon.</p>"), pageHtml("<script>render()</script><div id='app'></div>"), pageHtml(`<p>${"x".repeat(MIN_PAGE_CHARS - 1)}</p>`)]) {
      const w = world({ html });
      const error = await failure(importWebsite(context(), { url: "https://www.example.com/" }, w.deps));
      expect(error.code).toBe("validation_failed");
      expect(error.message).toBe(IMPORT_MESSAGES.tooLittle);
      expect(error.fields?.url).toBe(IMPORT_MESSAGES.tooLittle);
      expect(w.calls.filter((c) => c.startsWith("insert") || c.startsWith("replace"))).toEqual([]);
      expect(w.events).toEqual([]);
    }
  });

  it("a page at the smallest size is accepted", async () => {
    const w = world({ html: pageHtml(`<p>${"x".repeat(MIN_PAGE_CHARS)}</p>`) });
    await expect(importWebsite(context(), { url: "https://www.example.com/" }, w.deps)).resolves.toBeDefined();
  });

  it("a page with more text than the knowledge base can hold is refused in plain words", async () => {
    const huge = `<p>${"Word ".repeat(MAX_CHUNKS * 300)}</p>`;
    const w = world({ html: pageHtml(huge) });
    const error = await failure(importWebsite(context(), { url: "https://www.example.com/" }, w.deps));
    expect(error.code).toBe("validation_failed");
    expect(error.message).toBe(IMPORT_MESSAGES.tooLong);
    expect(w.calls.filter((c) => c.startsWith("insert") || c.startsWith("replace"))).toEqual([]);
  });
});

describe("a page built to be slow to read", () => {
  it.each([
    ["nested 50,000 levels deep", `<html><body>${"<div>".repeat(50_000)}x`],
    ["with 150,000 elements", `<html><body>${"<p>x</p>".repeat(150_000)}</body></html>`],
  ])("a page %s is refused in plain words, quickly, and nothing is stored", async (_name, html) => {
    const w = world({ html });
    const started = Date.now();
    const error = await failure(importWebsite(context(), { url: "https://www.example.com/" }, w.deps));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(error.code).toBe("validation_failed");
    expect(error.message).toBe(IMPORT_MESSAGES.complex);
    expect(error.fields?.url).toBe(IMPORT_MESSAGES.complex);
    expect(w.calls.filter((c) => c.startsWith("insert") || c.startsWith("replace"))).toEqual([]);
    expect(w.events).toEqual([]);
  });
});

describe("a new page", () => {
  it("is stored as a website document that is processing, with the page's title and text, and the address it was imported from", async () => {
    const w = world();
    const result = await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    const [doc] = w.docs();
    expect(doc).toMatchObject({ tenantId: A, sourceType: "website", sourceUrl: "https://www.example.com/about", title: "About us | Sunrise Homes", status: "processing" });
    expect(doc.body).toContain("About Skyline Towers");
    expect(doc.body).toContain("Skyline Towers has homes ready to move in, number 8.");
    expect(result).toEqual({ id: doc.id, title: "About us | Sunrise Homes", sourceType: "website", sourceUrl: "https://www.example.com/about", status: "processing", createdAt: doc.createdAt, replaced: false });
  });

  it("starts the same ingest job as an upload does, with ids only, under an event id of its own", async () => {
    const w = world();
    const { id } = await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(w.events).toEqual([{ id: kbWebsiteEventId(id, NOW.getTime()), name: KB_UPLOAD_EVENT, data: { tenantId: A, documentId: id } }]);
    expect(JSON.stringify(w.events)).not.toMatch(/Skyline|example\.com/);
  });

  it("takes the address as the parser writes it, without a #fragment, and keeps the query", async () => {
    const w = world();
    const result = await importWebsite(context(), { url: "  HTTPS://WWW.Example.COM:443/About?lang=ta#team  " }, w.deps);
    expect(result.sourceUrl).toBe("https://www.example.com/About?lang=ta");
    expect(w.fetched).toEqual(["https://www.example.com/About?lang=ta"]);
  });

  it("falls back to the address as the title when the page has none", async () => {
    const w = world({ html: `<p>${sentence(8)}</p>` });
    const result = await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(result.title).toBe("www.example.com/about");
  });

  it("puts the title at the top of the text, so a search for the page's name finds it", async () => {
    const w = world();
    await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(w.docs()[0].body?.startsWith("About us | Sunrise Homes\n")).toBe(true);
  });

  it("records the import in the audit log: who, which business, which document, whether it replaced one, and the site's name but not the page's address", async () => {
    const w = world();
    const { id } = await importWebsite(context("admin"), { url: "https://www.example.com/private/page?token=abc" }, w.deps);
    expect(w.audits).toEqual([{ tenantId: A, actor: USER, action: "kb.website_imported", entity: "kb_document", entityId: id, diff: { replaced: false, host: "www.example.com" } }]);
    expect(JSON.stringify(w.audits)).not.toMatch(/token|private/);
  });

  it("a failure to write the audit row is logged and does not fail the import", async () => {
    const w = world();
    (w.deps.audit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("audit down"));
    await expect(importWebsite(context(), { url: "https://www.example.com/about" }, w.deps)).resolves.toMatchObject({ replaced: false });
    expect(w.docs()).toHaveLength(1);
  });

  it("is never charged: no credits are touched (the importer does not know the ledger)", async () => {
    const w = world();
    await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(Object.keys(w.deps).sort()).toEqual(["audit", "fetchPage", "now", "send", "store"]);
  });
});

describe("the same address again", () => {
  const first = { id: "d1000000-0000-4000-8000-000000000001", tenantId: A, sourceType: "website", sourceUrl: "https://www.example.com/about", title: "Old title", body: "Old words", status: "ready" as const };

  it("replaces that page's content in the same document: new title and text, processing again, error cleared, and never a second document", async () => {
    const w = world({ docs: [{ ...first, error: "an old failure" }] });
    const result = await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(w.docs()).toHaveLength(1);
    expect(w.docs()[0]).toMatchObject({ id: first.id, title: "About us | Sunrise Homes", status: "processing", error: null, sourceUrl: "https://www.example.com/about" });
    expect(w.docs()[0].body).toContain("About Skyline Towers");
    expect(w.docs()[0].body).not.toContain("Old words");
    expect(result).toMatchObject({ id: first.id, replaced: true, status: "processing" });
  });

  it("starts the job again, under a new event id (the first import's id would be dropped as a repeat)", async () => {
    const w = world({ docs: [first] });
    await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    const later = new Date(NOW.getTime() + 3_600_000);
    w.clock.now = later;
    w.docs()[0].status = "ready";
    await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(w.events).toHaveLength(2);
    expect(new Set(w.events.map((e) => e.id)).size).toBe(2);
    expect(w.events.every((e) => e.data.documentId === first.id)).toBe(true);
  });

  it("a #fragment or letter case in the host does not make it a different page", async () => {
    const w = world({ docs: [first] });
    const result = await importWebsite(context(), { url: "https://WWW.example.com/about#contact" }, w.deps);
    expect(result.replaced).toBe(true);
    expect(w.docs()).toHaveLength(1);
  });

  it("a different address is a different page, and the first one is left alone", async () => {
    const w = world({ docs: [first] });
    const result = await importWebsite(context(), { url: "https://www.example.com/contact" }, w.deps);
    expect(result.replaced).toBe(false);
    expect(w.docs()).toHaveLength(2);
    expect(w.docs().find((d) => d.id === first.id)).toMatchObject({ title: "Old title", body: "Old words", status: "ready" });
  });

  it("if the page was imported twice somehow, the oldest keeps the page and the copies are removed", async () => {
    const copy = { ...first, id: "d1000000-0000-4000-8000-000000000002", createdAt: "2026-10-14T10:00:00.000Z" };
    const w = world({ docs: [{ ...first, createdAt: "2026-10-01T10:00:00.000Z" }, copy] });
    const result = await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(w.docs().map((d) => d.id)).toEqual([first.id]);
    expect(result.id).toBe(first.id);
  });

  it("other documents of the business (uploads, FAQs, other pages) are untouched", async () => {
    const w = world({
      docs: [first, { id: "d1000000-0000-4000-8000-0000000000a1", tenantId: A, sourceType: "upload", title: "Brochure", body: "Brochure words", status: "ready" }, { id: "d1000000-0000-4000-8000-0000000000a2", tenantId: A, sourceType: "manual", title: "Q?", body: "A.", status: "ready" }],
    });
    await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(w.docs().find((d) => d.title === "Brochure")).toMatchObject({ body: "Brochure words", status: "ready" });
    expect(w.docs().find((d) => d.sourceType === "manual")).toMatchObject({ title: "Q?", body: "A." });
  });

  it("is refused while that page is still being processed: a conflict, in words, and nothing is fetched or changed", async () => {
    const w = world({ docs: [{ ...first, status: "processing" }] });
    const error = await failure(importWebsite(context(), { url: "https://www.example.com/about" }, w.deps));
    expect(error.code).toBe("conflict");
    expect(error.message).toBe(IMPORT_MESSAGES.busy);
    expect(w.fetched).toEqual([]);
    expect(w.docs()[0]).toMatchObject({ title: "Old title", body: "Old words", status: "processing" });
    expect(w.events).toEqual([]);
  });

  it("a page whose last import failed can be imported again", async () => {
    const w = world({ docs: [{ ...first, status: "failed", error: "This document has no text to learn from." }] });
    const result = await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(result.replaced).toBe(true);
    expect(w.docs()[0]).toMatchObject({ status: "processing", error: null });
  });

  it("the audit row says it replaced one", async () => {
    const w = world({ docs: [first] });
    await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(w.audits[0].diff).toEqual({ replaced: true, host: "www.example.com" });
  });

  it("when the new page cannot be read, the old content stays exactly as it was", async () => {
    const w = world({ docs: [first], fail: new PageFetchError("status", 404) });
    await failure(importWebsite(context(), { url: "https://www.example.com/about" }, w.deps));
    expect(w.docs()[0]).toMatchObject({ title: "Old title", body: "Old words", status: "ready" });
  });
});

describe("one business never sees another's pages", () => {
  const theirs = { id: "d2000000-0000-4000-8000-000000000001", tenantId: B, sourceType: "website", sourceUrl: "https://www.example.com/about", title: "Their page", body: "Their words", status: "ready" as const };

  it("a page of another business at the same address is not this business's, and is left alone", async () => {
    const w = world({ docs: [theirs] });
    const result = await importWebsite(context("owner", A), { url: "https://www.example.com/about" }, w.deps);
    expect(result.replaced).toBe(false);
    expect(w.docs().find((d) => d.id === theirs.id)).toMatchObject({ title: "Their page", body: "Their words" });
    expect(w.docs().filter((d) => d.tenantId === A)).toHaveLength(1);
  });

  it("the document is stored for the business of the session, and every store call names it", async () => {
    const w = world();
    await importWebsite(context("owner", B), { url: "https://www.example.com/about" }, w.deps);
    expect(w.docs().every((d) => d.tenantId === B)).toBe(true);
    expect(w.tenantsSeen()).toEqual(new Set([B]));
    expect(w.events[0].data.tenantId).toBe(B);
    expect(w.audits[0].tenantId).toBe(B);
  });

  it("only the documents of this business count toward the limit", async () => {
    const docs = Array.from({ length: MAX_DOCUMENTS }, (_, i) => ({ id: `d3000000-0000-4000-8000-${String(i).padStart(12, "0")}`, tenantId: B, sourceType: "upload", title: `Doc ${i}` }));
    const w = world({ docs });
    await expect(importWebsite(context("owner", A), { url: "https://www.example.com/about" }, w.deps)).resolves.toBeDefined();
  });
});

describe("limits", () => {
  const filled = (n: number, tenantId = A) => Array.from({ length: n }, (_, i) => ({ id: `d4000000-0000-4000-8000-${String(i).padStart(12, "0")}`, tenantId, sourceType: "upload", title: `Doc ${i}`, status: "ready" as const }));

  it("a business at the document limit cannot add a new page, in words, and nothing is fetched", async () => {
    const w = world({ docs: filled(MAX_DOCUMENTS) });
    const error = await failure(importWebsite(context(), { url: "https://www.example.com/about" }, w.deps));
    expect(error.code).toBe("validation_failed");
    expect(error.message).toBe(IMPORT_MESSAGES.limit);
    expect(error.message).toContain(String(MAX_DOCUMENTS));
    expect(w.fetched).toEqual([]);
  });

  it("but can re-import a page it already has", async () => {
    const docs = [...filled(MAX_DOCUMENTS - 1), { id: "d5000000-0000-4000-8000-000000000001", tenantId: A, sourceType: "website", sourceUrl: "https://www.example.com/about", title: "Old", body: "x", status: "ready" as const }];
    const w = world({ docs });
    const result = await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(result.replaced).toBe(true);
  });

  it("20 imports in the last hour is the most: the 21st is refused with rate_limited, in words, before anything is fetched", async () => {
    const w = world({ recentImports: 20 });
    const error = await failure(importWebsite(context(), { url: "https://www.example.com/about" }, w.deps));
    expect(error.code).toBe("rate_limited");
    expect(error.message).toBe(IMPORT_MESSAGES.rate);
    expect(w.fetched).toEqual([]);
    const ok = world({ recentImports: 19 });
    await expect(importWebsite(context(), { url: "https://www.example.com/about" }, ok.deps)).resolves.toBeDefined();
  });

  it("counts the last hour, for this business", async () => {
    const w = world();
    await importWebsite(context("owner", B), { url: "https://www.example.com/about" }, w.deps);
    expect(w.importCounts).toEqual([{ tenantId: B, since: new Date(NOW.getTime() - 3_600_000).toISOString() }]);
  });
});

describe("when the job cannot be started", () => {
  it("a refusal: the page is marked failed (so it is not left processing) and the owner is told to try again", async () => {
    const w = world({ sendError: new Error("inngest unreachable at https://inn.example/key=secret") });
    const error = await failure(importWebsite(context(), { url: "https://www.example.com/about" }, w.deps));
    expect(error.code).toBe("upstream_failed");
    expect(error.message).toBe(IMPORT_MESSAGES.startFailed);
    expect(w.docs()[0]).toMatchObject({ status: "failed" });
    const logged = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toMatch(/secret|inn\.example/);
  });

  it("no answer in time is not a refusal: the page stands as processing, and the sweep fails it if no job ever finishes it", async () => {
    const w = world({ sendError: new TimeoutError() });
    const result = await importWebsite(context(), { url: "https://www.example.com/about" }, w.deps);
    expect(result.status).toBe("processing");
    expect(w.docs()[0].status).toBe("processing");
  });

  it("a refusal on a re-import marks that page failed as well (its old chunks stay until it is imported again)", async () => {
    const w = world({ sendError: new Error("down"), docs: [{ id: "d6000000-0000-4000-8000-000000000001", tenantId: A, sourceType: "website", sourceUrl: "https://www.example.com/about", title: "Old", body: "x", status: "ready" }] });
    await failure(importWebsite(context(), { url: "https://www.example.com/about" }, w.deps));
    expect(w.docs()[0].status).toBe("failed");
  });
});

describe("what is logged", () => {
  it("nothing of the page: no text, title or address", async () => {
    const w = world({ html: pageHtml(`<p>${sentence(8)} Secret price list for Priya</p>`) });
    await importWebsite(context(), { url: "https://www.example.com/private?token=abc" }, w.deps);
    const lines = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls].map((c) => c.join(" ")).join("\n");
    expect(lines).not.toMatch(/Secret price|Priya|token=abc|private/);
  });
});

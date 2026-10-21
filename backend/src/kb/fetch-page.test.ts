import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Resolver } from "../outbound-webhooks/transport";
import { checkPageUrl, fetchPage, makeHttpGet, MAX_REDIRECTS, PAGE_MAX_BYTES, PageFetchError, PAGE_TIMEOUT_MS, type HttpGet, type RawResponse } from "./fetch-page";

// Reading one web page safely (kb/fetch-page.ts). The business picks the address, so our server must not be turned against itself or its neighbours:
// only http and https on the normal ports, never a private, loopback, link-local or reserved address (checked for the address given, for every redirect, and for
// every address a name resolves to at the moment of connecting), a limited number of redirects, a limited size and time, and only HTML. Nothing here touches
// the network: the HTTP layer is a fake, and the resolver is a fake.

describe("checkPageUrl: which addresses may be asked for", () => {
  it.each(["https://www.example.com/about", "http://example.com", "https://example.com:443/x", "http://example.com:80/", "https://93.184.216.34/", "https://[2606:4700::1111]/", "https://example.com/a?b=1#frag", "HTTPS://EXAMPLE.COM/"])("allows %s", (value) => {
    expect(checkPageUrl(value)).toMatchObject({ ok: true });
  });

  it.each(["", "not a url", "example.com", "www.example.com/about", "https://"])("refuses %j as not an address", (value) => {
    expect(checkPageUrl(value)).toEqual({ ok: false, problem: "invalid" });
  });

  it.each(["ftp://example.com/file", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "gopher://example.com", "ws://example.com", "mailto:a@example.com"])("refuses %s: only http and https", (value) => {
    expect(checkPageUrl(value)).toMatchObject({ ok: false });
    expect(["scheme", "invalid"]).toContain((checkPageUrl(value) as { problem: string }).problem);
  });

  it.each(["https://user@example.com/", "https://user:pass@example.com/", "http://:pass@example.com/"])("refuses %s: no user name or password in the address", (value) => {
    expect(checkPageUrl(value)).toEqual({ ok: false, problem: "credentials" });
  });

  it.each(["https://example.com:8080/", "http://example.com:22/", "https://example.com:3306/", "http://example.com:8443/", "https://example.com:0/", "http://example.com:81/"])("refuses %s: only the normal web ports", (value) => {
    expect(checkPageUrl(value)).toEqual({ ok: false, problem: "port" });
  });

  it.each([
    "http://localhost/", "http://LOCALHOST/", "http://localhost./", "http://app.localhost/", "http://service.internal/", "http://db.railway.internal/", "http://metadata.google.internal/",
    "http://printer.local/", "http://router.lan/", "http://intranet/", "http://myserver/", "https://nodots/",
  ])("blocks the name %s", (value) => {
    expect(checkPageUrl(value)).toEqual({ ok: false, problem: "blocked" });
  });

  it.each([
    "http://127.0.0.1/", "http://127.1/", "http://0x7f000001/", "http://2130706433/", "http://017700000001/", "http://0.0.0.0/", "http://10.1.2.3/", "http://172.16.0.1/", "http://172.31.255.255/",
    "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/", "http://224.0.0.1/", "http://240.0.0.1/", "http://198.18.0.1/", "http://192.0.0.1/",
  ])("blocks the IPv4 address %s, in every way of writing it", (value) => {
    expect(checkPageUrl(value)).toEqual({ ok: false, problem: "blocked" });
  });

  it.each(["http://[::1]/", "http://[::]/", "http://[fc00::1]/", "http://[fd12:3456::1]/", "http://[fe80::1]/", "http://[ff02::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[64:ff9b::7f00:1]/", "http://[2001:db8::1]/"])(
    "blocks the IPv6 address %s",
    (value) => {
      expect(checkPageUrl(value)).toEqual({ ok: false, problem: "blocked" });
    },
  );

  it("reports the address as the parser normalised it", () => {
    const checked = checkPageUrl("HTTPS://Example.COM:443/About");
    expect(checked.ok && checked.url.href).toBe("https://example.com/About");
  });
});

// ---- following redirects ----------------------------------------------------------------------------------------------------------------------

const html = (body = "<p>Hello</p>") => new TextEncoder().encode(`<!doctype html><html><body>${body}</body></html>`);
const ok = (over: Partial<RawResponse> = {}): RawResponse => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: html(), ...over });
const redirect = (location: string | undefined, status = 301): RawResponse => ({ status, headers: location === undefined ? {} : { location }, body: new Uint8Array() });
const url = (value: string) => new URL(value);

/** A fake HTTP layer that answers from a table by address, and records what was asked. */
function fakeGet(answers: Record<string, RawResponse | Error | (() => RawResponse | Error)>) {
  const asked: { url: string; timeoutMs: number; maxBytes: number }[] = [];
  const get: HttpGet = vi.fn(async (target, options) => {
    asked.push({ url: target.href, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
    const answer = answers[target.href];
    if (answer === undefined) throw new Error(`the test did not expect a request for ${target.href}`);
    const resolved = typeof answer === "function" ? answer() : answer;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  });
  return { get, asked };
}

const kind = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(PageFetchError);
  return error as PageFetchError;
};

describe("fetchPage: the page, after any redirects", () => {
  it("returns the page's HTML and the address it ended at", async () => {
    const { get, asked } = fakeGet({ "https://example.com/": ok({ body: html("<p>Skyline Towers</p>") }) });
    const page = await fetchPage(url("https://example.com/"), { get });
    expect(page.finalUrl.href).toBe("https://example.com/");
    expect(page.html).toContain("Skyline Towers");
    expect(asked).toEqual([{ url: "https://example.com/", timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES }]);
  });

  it("follows a redirect, including a relative one, and gives the page it ended at", async () => {
    const { get } = fakeGet({ "http://example.com/": redirect("https://example.com/"), "https://example.com/": redirect("/home", 302), "https://example.com/home": ok() });
    expect((await fetchPage(url("http://example.com/"), { get })).finalUrl.href).toBe("https://example.com/home");
  });

  it.each([301, 302, 303, 307, 308])("follows a %i", async (status) => {
    const { get } = fakeGet({ "https://example.com/": redirect("https://example.com/b", status), "https://example.com/b": ok() });
    expect((await fetchPage(url("https://example.com/"), { get })).finalUrl.pathname).toBe("/b");
  });

  it("allows three redirects and refuses a fourth", async () => {
    expect(MAX_REDIRECTS).toBe(3);
    const chain = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`https://example.com/${i}`, redirect(`https://example.com/${i + 1}`)]));
    const three = fakeGet({ ...chain(3), "https://example.com/3": ok() });
    expect((await fetchPage(url("https://example.com/0"), { get: three.get })).finalUrl.pathname).toBe("/3");
    const four = fakeGet({ ...chain(4), "https://example.com/4": ok() });
    expect((await kind(fetchPage(url("https://example.com/0"), { get: four.get }))).kind).toBe("redirects");
    expect(four.asked).toHaveLength(4);
  });

  it("refuses a redirect loop", async () => {
    const { get } = fakeGet({ "https://example.com/a": redirect("https://example.com/b"), "https://example.com/b": redirect("https://example.com/a") });
    expect((await kind(fetchPage(url("https://example.com/a"), { get }))).kind).toBe("redirects");
  });

  it.each([
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["localhost", "http://localhost:80/admin"],
    ["a loopback address", "http://127.0.0.1/"],
    ["a private address", "http://10.0.0.5/"],
    ["an internal name", "http://db.railway.internal/"],
    ["an IPv6 loopback", "http://[::1]/"],
    ["an IPv4-mapped IPv6 loopback", "http://[::ffff:7f00:1]/"],
    ["a numeric loopback", "http://2130706433/"],
  ])("a redirect to %s is refused before anything is asked of it", async (_name, target) => {
    const { get, asked } = fakeGet({ "https://example.com/": redirect(target) });
    expect((await kind(fetchPage(url("https://example.com/"), { get }))).kind).toBe("blocked");
    expect(asked.map((a) => a.url)).toEqual(["https://example.com/"]);
  });

  it("a redirect to another scheme, a special port or an address with a password is refused", async () => {
    for (const target of ["ftp://example.com/x", "file:///etc/passwd", "https://example.com:8080/", "https://user:pw@example.com/"]) {
      const { get } = fakeGet({ "https://example.com/": redirect(target) });
      expect((await kind(fetchPage(url("https://example.com/"), { get }))).kind).toBe("blocked");
    }
  });

  it("a redirect with no place to go, or one that is not an address, is unreachable", async () => {
    expect((await kind(fetchPage(url("https://example.com/"), { get: fakeGet({ "https://example.com/": redirect(undefined) }).get }))).kind).toBe("unreachable");
    expect((await kind(fetchPage(url("https://example.com/"), { get: fakeGet({ "https://example.com/": redirect("http://[") }).get }))).kind).toBe("unreachable");
  });

  it("the address asked for first is checked as well, even if the caller forgot", async () => {
    const { get } = fakeGet({});
    expect((await kind(fetchPage(url("http://169.254.169.254/"), { get }))).kind).toBe("blocked");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("fetchPage: answers that are not a page", () => {
  it.each([[404], [403], [401], [410], [500], [502], [503], [429]])("a %i is refused, with the status", async (status) => {
    const { get } = fakeGet({ "https://example.com/": ok({ status, body: html("<p>Error</p>") }) });
    const error = await kind(fetchPage(url("https://example.com/"), { get }));
    expect(error.kind).toBe("status");
    expect(error.status).toBe(status);
  });

  it.each([[204], [206], [304], [300]])("a %i is not a page either", async (status) => {
    const { get } = fakeGet({ "https://example.com/": ok({ status }) });
    expect((await kind(fetchPage(url("https://example.com/"), { get }))).kind).toBe("status");
  });

  it.each([["text/plain"], ["application/pdf"], ["image/png"], ["application/json"], ["application/octet-stream"], ["text/css"], ["video/mp4"]])("%s is not a web page", async (type) => {
    const { get } = fakeGet({ "https://example.com/": ok({ headers: { "content-type": type } }) });
    expect((await kind(fetchPage(url("https://example.com/"), { get }))).kind).toBe("not_html");
  });

  it.each([["text/html"], ["TEXT/HTML; charset=UTF-8"], ["application/xhtml+xml"], ["text/html;charset=iso-8859-1"]])("%s is a web page", async (type) => {
    const { get } = fakeGet({ "https://example.com/": ok({ headers: { "content-type": type } }) });
    await expect(fetchPage(url("https://example.com/"), { get })).resolves.toBeDefined();
  });

  it("with no content type, HTML is recognised by its start and anything else is not a web page", async () => {
    const withHtml = fakeGet({ "https://example.com/": ok({ headers: {} }) });
    await expect(fetchPage(url("https://example.com/"), { get: withHtml.get })).resolves.toBeDefined();
    const binary = fakeGet({ "https://example.com/": ok({ headers: {}, body: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 1, 2, 3]) }) });
    expect((await kind(fetchPage(url("https://example.com/"), { get: binary.get }))).kind).toBe("not_html");
  });

  it("an answer that is still compressed is not read (the request asks for none)", async () => {
    const { get } = fakeGet({ "https://example.com/": ok({ headers: { "content-type": "text/html", "content-encoding": "gzip" } }) });
    expect((await kind(fetchPage(url("https://example.com/"), { get }))).kind).toBe("unreachable");
    const identity = fakeGet({ "https://example.com/": ok({ headers: { "content-type": "text/html", "content-encoding": "identity" } }) });
    await expect(fetchPage(url("https://example.com/"), { get: identity.get })).resolves.toBeDefined();
  });
});

describe("fetchPage: the text, in the page's own character set", () => {
  const send = (headers: Record<string, string>, body: Uint8Array) => fakeGet({ "https://example.com/": ok({ headers, body }) }).get;

  it("UTF-8 by default, with or without a byte order mark", async () => {
    const text = "<p>Café ₹65 lakh வேளச்சேரி</p>";
    const plain = await fetchPage(url("https://example.com/"), { get: send({ "content-type": "text/html" }, new TextEncoder().encode(text)) });
    expect(plain.html).toBe(text);
    const withMark = await fetchPage(url("https://example.com/"), { get: send({ "content-type": "text/html" }, new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)])) });
    expect(withMark.html).toBe(text);
  });

  it("the character set named in the content type", async () => {
    const latin1 = new Uint8Array([...new TextEncoder().encode("<p>Caf"), 0xe9, ...new TextEncoder().encode("</p>")]);
    expect((await fetchPage(url("https://example.com/"), { get: send({ "content-type": "text/html; charset=iso-8859-1" }, latin1) })).html).toBe("<p>Café</p>");
  });

  it("the character set named in the page's <meta> when the header names none", async () => {
    const latin1 = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1252"><p>Caf'), 0xe9, ...new TextEncoder().encode("</p>")]);
    expect((await fetchPage(url("https://example.com/"), { get: send({ "content-type": "text/html" }, latin1) })).html).toContain("Café");
  });

  it("an unknown character set falls back to UTF-8 instead of failing", async () => {
    const page = await fetchPage(url("https://example.com/"), { get: send({ "content-type": "text/html; charset=klingon" }, new TextEncoder().encode("<p>Plain</p>")) });
    expect(page.html).toBe("<p>Plain</p>");
  });
});

describe("fetchPage: time and failures", () => {
  it("gives each request only the time that is left of 15 seconds in all", async () => {
    expect(PAGE_TIMEOUT_MS).toBe(15_000);
    let now = 1_000;
    const asked: number[] = [];
    const get: HttpGet = async (target, options) => {
      asked.push(options.timeoutMs);
      now += 6_000;
      return target.pathname === "/a" ? redirect("https://example.com/b") : ok();
    };
    await fetchPage(url("https://example.com/a"), { get, now: () => now });
    expect(asked).toEqual([15_000, 9_000]);
  });

  it("is a timeout when the time is used up before the next request", async () => {
    let now = 0;
    const get: HttpGet = vi.fn(async () => {
      now += 16_000;
      return redirect("https://example.com/b");
    });
    expect((await kind(fetchPage(url("https://example.com/a"), { get, now: () => now }))).kind).toBe("timeout");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("passes on what the HTTP layer says (blocked, too large, timeout, unreachable)", async () => {
    for (const failure of ["blocked", "too_large", "timeout", "unreachable"] as const) {
      const { get } = fakeGet({ "https://example.com/": new PageFetchError(failure) });
      expect((await kind(fetchPage(url("https://example.com/"), { get }))).kind).toBe(failure);
    }
  });

  it("makes anything else that goes wrong 'unreachable', without its message", async () => {
    const { get } = fakeGet({ "https://example.com/": new Error("connect ECONNREFUSED 10.0.0.1:443 secret-host.internal") });
    const error = await kind(fetchPage(url("https://example.com/"), { get }));
    expect(error.kind).toBe("unreachable");
    expect(error.message).not.toMatch(/10\.0\.0\.1|secret-host/);
  });
});

// ---- the real HTTP layer, with a fake `request` and a fake resolver -----------------------------------------------------------------------------

type Handler = (res: Readable & { statusCode?: number; headers: Record<string, string | string[] | undefined> }) => void;

/** A fake of node's http(s).request: records the options, and lets a test answer, time out or fail. */
function fakeRequest(behave: (req: EventEmitter & { destroyed: boolean; destroy: (e?: Error) => void; end: () => void }, respond: Handler, options: Record<string, unknown>) => void) {
  const seen: { url: string; options: Record<string, unknown> }[] = [];
  const request = ((target: URL, options: Record<string, unknown>, callback: Handler) => {
    seen.push({ url: target.href, options });
    const emitter = new EventEmitter();
    const req = Object.assign(emitter, {
      destroyed: false,
      destroy(error?: Error) {
        req.destroyed = true;
        if (error) queueMicrotask(() => emitter.emit("error", error));
      },
      end() {
        queueMicrotask(() => behave(req, callback, options));
      },
    });
    return req;
  }) as never;
  return { request, seen };
}

const response = (status: number, headers: Record<string, string>, chunks: Uint8Array[]) => Object.assign(Readable.from(chunks), { statusCode: status, headers });
const publicResolver: Resolver = (_host, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]);
const options = { timeoutMs: 5_000, maxBytes: 1_000 };

describe("makeHttpGet: one request", () => {
  it("asks for HTML, with no compression and a clear user agent, and returns the status, the headers and the body", async () => {
    const { request, seen } = fakeRequest((_req, respond) => respond(response(200, { "content-type": "text/html" }, [new TextEncoder().encode("<p>Hi</p>")])));
    const got = await makeHttpGet({ request, resolver: publicResolver })(url("https://example.com/x"), options);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toBe("text/html");
    expect(new TextDecoder().decode(got.body)).toBe("<p>Hi</p>");
    expect(seen[0].url).toBe("https://example.com/x");
    expect(seen[0].options).toMatchObject({ method: "GET", headers: { "accept-encoding": "identity", accept: expect.stringContaining("text/html"), "user-agent": expect.stringContaining("PakkaAgent") } });
    expect(JSON.stringify(seen[0].options.headers)).not.toMatch(/authorization|cookie/i);
  });

  it("connects only to public addresses: the lookup it gives the socket refuses a name that resolves to a private one, and accepts a public one", async () => {
    const { request, seen } = fakeRequest((_req, respond) => respond(response(200, {}, [])));
    const privateResolver: Resolver = (_host, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }]);
    await makeHttpGet({ request, resolver: privateResolver })(url("https://rebinding.example.com/"), options);
    const lookup = seen[0].options.lookup as (host: string, opts: { all?: boolean }, cb: (err: (Error & { code?: string }) | null, address: unknown) => void) => void;
    const refused = await new Promise<Error & { code?: string }>((resolve) => lookup("rebinding.example.com", {}, (err) => resolve(err as never)));
    expect(refused.code).toBe("REFUSED_ADDRESS");
    const mixed: Resolver = (_host, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    const mixedGet = makeHttpGet({ request, resolver: mixed });
    await mixedGet(url("https://example.com/"), options);
    const mixedLookup = seen[1].options.lookup as typeof lookup;
    expect((await new Promise<Error & { code?: string }>((resolve) => mixedLookup("example.com", {}, (err) => resolve(err as never)))).code).toBe("REFUSED_ADDRESS");
    await makeHttpGet({ request, resolver: publicResolver })(url("https://example.com/"), options);
    const okLookup = seen[2].options.lookup as typeof lookup;
    expect(await new Promise((resolve) => okLookup("example.com", {}, (err, address) => resolve(err ?? address)))).toBe("93.184.216.34");
  });

  it("a connection refused by that lookup is 'blocked'", async () => {
    const { request } = fakeRequest((req) => req.destroy(Object.assign(new Error("private"), { code: "REFUSED_ADDRESS" })));
    await expect(makeHttpGet({ request, resolver: publicResolver })(url("https://example.com/"), options)).rejects.toMatchObject({ name: "PageFetchError", kind: "blocked" });
  });

  it("a page larger than the limit is refused as soon as the limit is passed, and the rest is not read", async () => {
    let destroyed = false;
    const big = new Uint8Array(600);
    const stream = Object.assign(Readable.from([big, big, big]), { statusCode: 200, headers: { "content-type": "text/html" } });
    const originalDestroy = stream.destroy.bind(stream);
    stream.destroy = ((error?: Error) => {
      destroyed = true;
      return originalDestroy(error);
    }) as never;
    const { request } = fakeRequest((_req, respond) => respond(stream));
    await expect(makeHttpGet({ request, resolver: publicResolver })(url("https://example.com/"), options)).rejects.toMatchObject({ kind: "too_large" });
    expect(destroyed).toBe(true);
  });

  it("a declared length over the limit is refused before any of the body is read", async () => {
    const { request } = fakeRequest((_req, respond) => respond(response(200, { "content-type": "text/html", "content-length": "99999999" }, [new Uint8Array(10)])));
    await expect(makeHttpGet({ request, resolver: publicResolver })(url("https://example.com/"), options)).rejects.toMatchObject({ kind: "too_large" });
  });

  it("a page exactly at the limit is read", async () => {
    const { request } = fakeRequest((_req, respond) => respond(response(200, { "content-type": "text/html" }, [new Uint8Array(500), new Uint8Array(500)])));
    expect((await makeHttpGet({ request, resolver: publicResolver })(url("https://example.com/"), options)).body.length).toBe(1_000);
  });

  it("does not read the body of a redirect or an error", async () => {
    const { request } = fakeRequest((_req, respond) => respond(response(301, { location: "https://example.com/b" }, [new Uint8Array(5_000)])));
    const got = await makeHttpGet({ request, resolver: publicResolver })(url("https://example.com/"), options);
    expect(got.status).toBe(301);
    expect(got.headers.location).toBe("https://example.com/b");
    expect(got.body.length).toBe(0);
  });

  it("the time given is the request's own deadline: a request that has not answered by then is a timeout", async () => {
    vi.useFakeTimers();
    try {
      const { request } = fakeRequest(() => undefined); // never answers
      const pending = makeHttpGet({ request, resolver: publicResolver })(url("https://example.com/"), { timeoutMs: 2_000, maxBytes: 1_000 });
      const assertion = expect(pending).rejects.toMatchObject({ kind: "timeout" });
      await vi.advanceTimersByTimeAsync(2_100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a body that stalls half way is a timeout too (the deadline covers the whole read)", async () => {
    vi.useFakeTimers();
    try {
      const stalled = new Readable({ read() {} });
      stalled.push(new Uint8Array(10));
      const res = Object.assign(stalled, { statusCode: 200, headers: { "content-type": "text/html" } });
      const { request } = fakeRequest((_req, respond) => respond(res));
      const pending = makeHttpGet({ request, resolver: publicResolver })(url("https://example.com/"), { timeoutMs: 2_000, maxBytes: 1_000 });
      const assertion = expect(pending).rejects.toMatchObject({ kind: "timeout" });
      await vi.advanceTimersByTimeAsync(2_100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "CERT_HAS_EXPIRED", "EPROTO"])("%s is 'unreachable', without the error's own words", async (code) => {
    const { request } = fakeRequest((req) => req.destroy(Object.assign(new Error("connect to 10.0.0.1 failed"), { code })));
    const error = await makeHttpGet({ request, resolver: publicResolver })(url("https://example.com/"), options).then(() => null, (e: unknown) => e as PageFetchError);
    expect(error?.kind).toBe("unreachable");
    expect(error?.message).not.toContain("10.0.0.1");
  });
});

import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { WEBSITE_IMPORT_LIMITS } from "@pakka/types";
import { isPublicAddress, safeLookup, type Resolver } from "../outbound-webhooks/transport";

// Reading one web page safely, for the knowledge base (kb/website.ts). The business picks the address, so our server must not be turned against itself or its
// neighbours (SSRF): only http and https on the normal ports, never a private, loopback, link-local or reserved address. The address is checked when it is given and
// again for every redirect, and every address a name resolves to is checked at the moment of connecting (safeLookup, from the outbound webhooks' transport: a name that
// later points somewhere private, DNS rebinding, is refused too). A limited number of redirects, size and time; HTML only; no compression asked for (so nothing
// to decompress); no cookies or credentials sent; and no JavaScript is run.

export const PAGE_MAX_BYTES = WEBSITE_IMPORT_LIMITS.maxPageBytes;
export const PAGE_TIMEOUT_MS = WEBSITE_IMPORT_LIMITS.timeoutSeconds * 1000;
export const MAX_REDIRECTS = WEBSITE_IMPORT_LIMITS.maxRedirects;
export const PAGE_USER_AGENT = "PakkaAgent-KnowledgeImport/1 (+https://pakkaagent.in)";

const PORTS = new Set(["", "80", "443"]);
const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home|lan|intranet|corp|railway\.internal)$/i;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type PageProblem = "invalid" | "scheme" | "credentials" | "port" | "blocked";

/** Whether an address may be asked for, and why not. The parsed address is the one the parser normalised (numeric hosts like 2130706433 or 0x7f000001 become 127.0.0.1). */
export function checkPageUrl(value: string): { ok: true; url: URL } | { ok: false; problem: PageProblem } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, problem: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, problem: "scheme" };
  if (url.username || url.password) return { ok: false, problem: "credentials" };
  if (!PORTS.has(url.port)) return { ok: false, problem: "port" };
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "") return { ok: false, problem: "invalid" };
  const blocked = isIP(host) ? !isPublicAddress(host) : LOCAL_NAMES.test(host) || !host.includes(".");
  return blocked ? { ok: false, problem: "blocked" } : { ok: true, url };
}

export type FetchFailure = "blocked" | "unreachable" | "timeout" | "status" | "not_html" | "too_large" | "redirects";

export class PageFetchError extends Error {
  constructor(
    readonly kind: FetchFailure,
    /** The HTTP status, for "status". */
    readonly status?: number,
  ) {
    super(`the page could not be read (${kind}${status === undefined ? "" : ` ${status}`})`);
    this.name = "PageFetchError";
  }
}

export interface RawResponse {
  status: number;
  /** Lower-case names, the first value of each. */
  headers: Record<string, string | undefined>;
  /** Only an answer of 200 has a body, and never more than `maxBytes`. */
  body: Uint8Array;
}
export type HttpGet = (url: URL, options: { timeoutMs: number; maxBytes: number }) => Promise<RawResponse>;

type RequestFn = (url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => import("node:http").ClientRequest;
const defaultRequest: RequestFn = (url, options, callback) => (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, callback);

/** One GET with a deadline for the whole read, a limit on the body, and the address guard on the connection. Never throws anything but a PageFetchError. */
export function makeHttpGet({ request = defaultRequest, resolver }: { request?: RequestFn; resolver?: Resolver } = {}): HttpGet {
  return (url, { timeoutMs, maxBytes }) =>
    new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const fail = (kind: FetchFailure) => finish(() => reject(new PageFetchError(kind)));
      const timer = setTimeout(() => {
        req.destroy();
        fail("timeout");
      }, timeoutMs);

      const req = request(
        url,
        {
          method: "GET",
          headers: { "user-agent": PAGE_USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", "accept-encoding": "identity" },
          lookup: safeLookup(resolver) as never,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(res.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
          if (status !== 200) {
            // A redirect or an error has nothing we want: its body is not read.
            res.resume();
            res.destroy();
            req.destroy();
            return finish(() => resolve({ status, headers, body: new Uint8Array() }));
          }
          const declared = Number(headers["content-length"]);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            req.destroy();
            return fail("too_large");
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              res.destroy();
              req.destroy();
              return fail("too_large");
            }
            chunks.push(chunk);
          });
          res.on("end", () => finish(() => resolve({ status, headers, body: new Uint8Array(Buffer.concat(chunks)) })));
          res.on("error", () => fail("unreachable"));
          res.on("close", () => fail("unreachable")); // closed before it ended
        },
      );
      req.on("error", (error: NodeJS.ErrnoException) => fail(error.code === "REFUSED_ADDRESS" ? "blocked" : "unreachable"));
      req.end();
    });
}

const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)\s*(;|$)/i;
const HTML_START = /<\s*(!doctype|html|head|body|title|h1|p|div)\b/i;

function decode(bytes: Uint8Array, contentType: string | undefined): string {
  const named = /charset\s*=\s*"?([^;"\s]+)/i.exec(contentType ?? "")?.[1];
  const sniffed = named ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 2048)))?.[1];
  try {
    return new TextDecoder(sniffed ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // a character set we do not know: read it as UTF-8 rather than fail
  }
}

/** The page's HTML, after at most MAX_REDIRECTS redirects, each checked like the first address. Throws a PageFetchError. */
export async function fetchPage(
  start: URL,
  { get = makeHttpGet(), now = Date.now }: { get?: HttpGet; now?: () => number } = {},
): Promise<{ finalUrl: URL; html: string }> {
  const deadline = now() + PAGE_TIMEOUT_MS;
  let current = start;
  for (let redirects = 0; ; ) {
    if (!checkPageUrl(current.href).ok) throw new PageFetchError("blocked");
    const remaining = deadline - now();
    if (remaining <= 0) throw new PageFetchError("timeout");
    let response: RawResponse;
    try {
      response = await get(current, { timeoutMs: remaining, maxBytes: PAGE_MAX_BYTES });
    } catch (error) {
      throw error instanceof PageFetchError ? error : new PageFetchError("unreachable"); // nothing of the error's own message
    }

    if (REDIRECTS.has(response.status)) {
      if (redirects >= MAX_REDIRECTS) throw new PageFetchError("redirects");
      redirects++;
      const location = response.headers.location;
      if (!location) throw new PageFetchError("unreachable");
      try {
        current = new URL(location, current);
      } catch {
        throw new PageFetchError("unreachable");
      }
      continue;
    }
    if (response.status !== 200) throw new PageFetchError("status", response.status);

    const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
    if (encoding && encoding !== "identity") throw new PageFetchError("unreachable");
    const type = response.headers["content-type"];
    if (type !== undefined ? !HTML_TYPE.test(type.trim()) : !HTML_START.test(new TextDecoder("latin1").decode(response.body.subarray(0, 1024)))) throw new PageFetchError("not_html");
    return { finalUrl: current, html: decode(response.body, type) };
  }
}

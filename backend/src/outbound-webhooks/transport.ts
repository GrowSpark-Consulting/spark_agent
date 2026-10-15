import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

// The business picks the URL, so our server must not be turned against itself or its neighbours (SSRF): only https, on
// 443 or 8443, never to an address on a private, loopback, link-local or reserved network. The name is checked when it
// is saved (checkWebhookUrl) and every address it resolves to is checked again at the moment of connecting (safeLookup),
// so a name that later points somewhere private (DNS rebinding) is refused too. Redirects are not followed, and the
// answer's body is never read.

const PORTS = new Set(["", "443", "8443"]);
const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home|lan|intranet|corp|railway\.internal)$/i;

// One list per family: a BlockList also matches IPv4 addresses against IPv6 rules (::ffff:0:0/96 would block them all).
const blockedV4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(net, prefix, "ipv4");
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedV6.addSubnet(net, prefix, "ipv6");

/** True for an address on the public internet. An IPv4-mapped IPv6 address in dotted form is judged by its IPv4 part. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family === 6) return !blockedV6.check(address, "ipv6");
  return false;
}

/** Why a URL can't be a webhook endpoint, in words for the owner; null when it can. */
export function checkWebhookUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter the full address, starting with https://.";
  }
  if (url.protocol !== "https:") return "The address must start with https://.";
  if (url.username || url.password) return "Leave the user name and password out of the address.";
  if (!PORTS.has(url.port)) return "Use the standard https port (443) or 8443.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) ? !isPublicAddress(host) : LOCAL_NAMES.test(host) || !host.includes(".")) {
    return "That address is on a private network. Use your CRM's public https address.";
  }
  return null;
}

export type Resolver = (hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const systemResolver: Resolver = (hostname, callback) => dnsLookup(hostname, { all: true }, callback);

export class RefusedAddressError extends Error {
  readonly code = "REFUSED_ADDRESS";
  constructor() {
    super("the webhook address resolves to a private network");
    this.name = "RefusedAddressError";
  }
}

/** A `lookup` for the socket: every address the name resolves to must be public, or the connection is not made. */
export function safeLookup(resolve: Resolver = systemResolver) {
  return (
    hostname: string,
    options: { all?: boolean },
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    resolve(hostname, (err, addresses) => {
      if (err) return callback(err, "");
      if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) return callback(new RefusedAddressError(), "");
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export type PostResult = { status: number } | { error: "timeout" | "refused_address" | "connection_failed" };
export type Post = (url: string, body: string, headers: Record<string, string>) => Promise<PostResult>;

export const TIMEOUT_MS = 10_000;

/** POSTs the body; resolves with the status, or why there was none. Never throws, never reads the answer. */
export function makePost(resolve: Resolver = systemResolver, timeoutMs = TIMEOUT_MS): Post {
  return (url, body, headers) =>
    new Promise((done) => {
      if (checkWebhookUrl(url) !== null) return done({ error: "refused_address" });
      const req = request(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body).toString(), "user-agent": "PakkaAgent-Webhooks/1", ...headers },
          lookup: safeLookup(resolve) as never,
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          req.destroy();
          done({ status: res.statusCode ?? 0 });
        },
      );
      req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
      req.on("error", (e: NodeJS.ErrnoException) =>
        done({ error: e.code === "TIMEOUT" ? "timeout" : e.code === "REFUSED_ADDRESS" ? "refused_address" : "connection_failed" }),
      );
      req.end(body);
    });
}

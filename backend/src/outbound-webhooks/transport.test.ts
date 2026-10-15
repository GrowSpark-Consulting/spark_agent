import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi } from "vitest";
import { checkWebhookUrl, isPublicAddress, makePost, safeLookup, type Resolver } from "./transport";

const resolverOf =
  (...addresses: string[]): Resolver =>
  (_host, callback) =>
    callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

describe("isPublicAddress", () => {
  it.each(["8.8.8.8", "1.1.1.1", "13.235.10.20", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("lets %s through", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1",
    "::ffff:169.254.169.254", "64:ff9b::a00:1", "not-an-ip",
  ])("refuses %s (private, loopback, link-local, metadata or reserved)", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe("checkWebhookUrl", () => {
  it.each(["https://hooks.zapier.com/hooks/catch/1/abc/", "https://crm.example.in/in", "https://crm.example.in:8443/in", "https://8.8.8.8/x"])(
    "accepts %s",
    (url) => expect(checkWebhookUrl(url)).toBeNull(),
  );

  it.each([
    ["not a URL", "crm.example.in/in", "starting with https://"],
    ["plain http", "http://crm.example.in/in", "must start with https://"],
    ["a user name and password", "https://me:pw@crm.example.in/in", "user name and password"],
    ["another port", "https://crm.example.in:22/in", "port"],
    ["localhost", "https://localhost/in", "private network"],
    ["a private IP", "https://10.0.0.5/in", "private network"],
    ["the cloud metadata address", "https://169.254.169.254/latest", "private network"],
    ["an IPv6 loopback", "https://[::1]/in", "private network"],
    ["Railway's private network", "https://api.railway.internal/in", "private network"],
    ["a name with no domain", "https://intranet/in", "private network"],
  ])("refuses %s, saying why", (_name, url, words) => {
    expect(checkWebhookUrl(url)).toContain(words);
  });
});

describe("safeLookup: the address is checked when connecting (DNS rebinding)", () => {
  const lookup = (resolver: Resolver, all: boolean) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: string | LookupAddress[] }>((done) =>
      safeLookup(resolver)("crm.example.in", { all }, (err, address) => done({ err, address })),
    );

  it("hands the socket the public addresses", async () => {
    expect(await lookup(resolverOf("13.235.10.20"), false)).toEqual({ err: null, address: "13.235.10.20" });
    expect((await lookup(resolverOf("13.235.10.20", "2606:4700::1"), true)).address).toHaveLength(2);
  });

  it("refuses a name that resolves to any private address, even beside a public one", async () => {
    expect((await lookup(resolverOf("10.0.0.5"), false)).err?.code).toBe("REFUSED_ADDRESS");
    expect((await lookup(resolverOf("13.235.10.20", "127.0.0.1"), true)).err?.code).toBe("REFUSED_ADDRESS");
  });

  it("passes on a lookup failure", async () => {
    const failing: Resolver = (_h, callback) => callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
    expect((await lookup(failing, false)).err?.code).toBe("ENOTFOUND");
  });
});

describe("makePost", () => {
  it("never connects to a name that resolves to a private address", async () => {
    const resolver = vi.fn(resolverOf("169.254.169.254"));
    await expect(makePost(resolver)("https://crm.example.in/in", "{}", {})).resolves.toEqual({ error: "refused_address" });
    expect(resolver).toHaveBeenCalledWith("crm.example.in", expect.any(Function));
  });

  it("refuses a URL that is not allowed before looking anything up", async () => {
    const resolver = vi.fn(resolverOf("13.235.10.20"));
    await expect(makePost(resolver)("http://crm.example.in/in", "{}", {})).resolves.toEqual({ error: "refused_address" });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("answers a name that does not resolve as connection_failed", async () => {
    const failing: Resolver = (_h, callback) => callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
    await expect(makePost(failing)("https://nowhere.example.in/in", "{}", {})).resolves.toEqual({ error: "connection_failed" });
  });
});

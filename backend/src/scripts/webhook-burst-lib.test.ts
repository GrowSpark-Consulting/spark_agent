import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { burstBody, passes, percentile, runBurst, sign } from "./webhook-burst-lib";

describe("webhook burst helpers", () => {
  it("signs the exact body the way Meta does", () => {
    expect(sign("s", "{}")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sign("a", "{}")).not.toBe(sign("b", "{}"));
  });

  it("makes a message body for a number no business owns, with a different message id each time", () => {
    const a = JSON.parse(burstBody("100000000000000", 1));
    expect(a.entry[0].changes[0].value.metadata.phone_number_id).toBe("100000000000000");
    expect(a.entry[0].changes[0].value.messages[0].id).not.toBe(JSON.parse(burstBody("100000000000000", 2)).entry[0].changes[0].value.messages[0].id);
  });

  it("takes percentiles of sorted times", () => {
    const t = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(t, 50), percentile(t, 95), percentile([], 95)]).toEqual([50, 95, 0]);
  });

  it("runs the burst against a server, counts statuses, and passes only when all are 200 and fast", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(String(req.headers["x-hub-signature-256"]));
      const failThis = seen.length === 7;
      req.resume();
      req.on("end", () => res.writeHead(failThis ? 500 : 200).end("ok"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/whatsapp`;
    try {
      const mixed = await runBurst({ url, secret: "s", total: 20, concurrency: 5 });
      expect(mixed.statuses).toEqual({ "200": 19, "500": 1 });
      expect(passes(mixed)).toBe(false);
      expect(seen.every((h) => /^sha256=[0-9a-f]{64}$/.test(h))).toBe(true);
      expect(passes({ total: 10, statuses: { "200": 10 }, p50: 5, p95: 50, max: 90, seconds: 1 })).toBe(true);
      expect(passes({ total: 10, statuses: { "200": 10 }, p50: 5, p95: 2500, max: 3000, seconds: 1 })).toBe(false);
    } finally {
      server.close();
    }
  });

  it("counts a refused connection as a network error, never a throw", async () => {
    const r = await runBurst({ url: "http://127.0.0.1:1/x", secret: "s", total: 2, concurrency: 2 });
    expect(r.statuses).toEqual({ network_error: 2 });
  });
});

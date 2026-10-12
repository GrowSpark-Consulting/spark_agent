import type { Page } from "@playwright/test";

// Stand-ins for API routes in browser tests. page.route answers a call so a test can check what the screen sends and how it reads each
// answer; it does NOT prove the real route exists or agrees. Use it for routes that need Meta, a model or the service-role database, and
// for routes whose answer a test must choose (a refusal, a held request, a bad body).
// Preflights go to the real API (it answers a missing route's OPTIONS for the frontend's origin), so only the call itself is answered here.

export interface ApiCall {
  method: string;
  url: URL;
  tenant: string | null;
  authorization: string | null;
  body: unknown;
}
export interface ApiAnswer {
  status: number;
  body: unknown;
}

/** Answers every non-preflight request to `path` with `answer(callNumber, call)`; returns the calls, in order. */
export async function stubApi(page: Page, path: RegExp, answer: (n: number, call: ApiCall) => ApiAnswer | Promise<ApiAnswer>): Promise<ApiCall[]> {
  const calls: ApiCall[] = [];
  await page.route(path, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const text = req.postData();
    const call: ApiCall = {
      method: req.method(),
      url: new URL(req.url()),
      tenant: req.headers()["x-pakka-tenant"] ?? null,
      authorization: req.headers()["authorization"] ?? null,
      body: text ? (JSON.parse(text) as unknown) : null,
    };
    calls.push(call);
    const result = await answer(calls.length, call);
    return route.fulfill({
      status: result.status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": req.headers()["origin"] ?? "*" },
      body: JSON.stringify(result.body),
    });
  });
  return calls;
}

export const refusal = (status: number, code: string, message: string): ApiAnswer => ({ status, body: { error: { code, message } } });

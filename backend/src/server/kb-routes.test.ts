import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";
import { errorOf } from "../test-support/http";

// The knowledge-base document routes: how they are wired (who may call, which tenant, which status). What
// the services do is tested in kb/documents.test.ts.

const uploadDocument = vi.fn();
const deleteDocument = vi.fn();
vi.mock("../kb/documents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../kb/documents")>()),
  uploadDocument: (...args: unknown[]) => uploadDocument(...args),
  deleteDocument: (...args: unknown[]) => deleteDocument(...args),
}));
const auditQuietly = vi.fn();
vi.mock("../lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/audit")>()),
  auditQuietly: (...args: unknown[]) => auditQuietly(...args),
}));

const { bodyLimitFor, createApp } = await import("./app");
const { createHttpServer } = await import("./node");
const { AppError } = await import("../lib/errors");

const FRONTEND = "https://app.pakkaagent.in";
const REALTY = "10000000-0000-0000-0000-000000000001";
const SALON = "10000000-0000-0000-0000-000000000002";
const tenantRow = (id: string, name: string) => ({ id, name, vertical: "real-estate", timezone: "Asia/Kolkata", status: "trial", plan_key: "trial", trial_ends_at: null });
const member = (id: string, name: string, role: string) => ({ tenant_id: id, role, tenants: tenantRow(id, name) });

const ACCOUNTS: Record<string, { email: string; memberships: unknown[] }> = {
  "owner.token.sig": { email: "owner@test.local", memberships: [member(REALTY, "Test Realty", "owner")] },
  "multi.token.sig": { email: "multi@test.local", memberships: [member(REALTY, "Test Realty", "owner"), member(SALON, "Beta Salon", "admin")] },
  "nomember.token.sig": { email: "nomember@test.local", memberships: [] },
};

function fakeUserClient(token: string): SupabaseClient {
  const account = ACCOUNTS[token];
  const { client } = fakeSupabase({ memberships: { data: account?.memberships ?? [], error: null } });
  const getUser = async (jwt: string) => {
    const known = ACCOUNTS[jwt];
    return known
      ? { data: { user: { id: `user-${known.email}`, email: known.email } }, error: null }
      : { data: { user: null }, error: { __isAuthError: true, name: "AuthApiError", status: 401, message: "invalid JWT" } };
  };
  return Object.assign(client, { auth: { getUser } });
}

const app = createApp({ userClient: fakeUserClient, inngest: async () => Response.json({}), allowedOrigins: new Set([FRONTEND]) });
const as = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, origin: FRONTEND, ...extra });

function upload(headers: Record<string, string>) {
  const form = new FormData();
  form.set("file", new File(["hello"], "Price list.txt"));
  return app(new Request("http://localhost:4000/api/kb/documents", { method: "POST", headers, body: form }));
}

beforeEach(() => {
  uploadDocument.mockReset();
  deleteDocument.mockReset();
  auditQuietly.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/kb/documents", () => {
  const created = { id: "d1", title: "Price list", sourceType: "upload", status: "processing", createdAt: "2026-10-08T10:00:00.000Z" };

  it("answers 202 with the document, for the signed-in member's business, and hands the service the request", async () => {
    uploadDocument.mockResolvedValue(created);
    const res = await upload(as("owner.token.sig"));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(created);
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    const [context, request] = uploadDocument.mock.calls[0];
    expect(context.tenant.id).toBe(REALTY);
    expect(context.role).toBe("owner");
    expect(request).toBeInstanceOf(Request);
  });

  it("takes the business from X-Pakka-Tenant only if it is one of the caller's own", async () => {
    uploadDocument.mockResolvedValue(created);
    await upload(as("multi.token.sig", { "x-pakka-tenant": SALON }));
    expect(uploadDocument.mock.calls[0][0].tenant.id).toBe(SALON);
    uploadDocument.mockClear();
    await upload(as("owner.token.sig", { "x-pakka-tenant": SALON })); // not theirs: ignored
    expect(uploadDocument.mock.calls[0][0].tenant.id).toBe(REALTY);
  });

  it("never reads the upload for a caller who is not signed in, or has no business", async () => {
    const signedOut = await upload({ origin: FRONTEND });
    expect(signedOut.status).toBe(401);
    expect((await errorOf(signedOut)).code).toBe("unauthenticated");
    const badToken = await upload(as("nope.token.sig"));
    expect(badToken.status).toBe(401);
    const noBusiness = await upload(as("nomember.token.sig"));
    expect(noBusiness.status).toBe(403);
    expect((await errorOf(noBusiness)).code).toBe("no_membership");
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it("turns the service's errors into the envelope, with the file field the frontend shows", async () => {
    uploadDocument.mockRejectedValue(new AppError("validation_failed", "Too big.", { file: "This file is larger than 5 MB." }));
    const res = await upload(as("owner.token.sig"));
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toEqual({ code: "validation_failed", message: "Too big.", fields: { file: "This file is larger than 5 MB." } });
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
  });

  it("answers an unexpected failure with a generic message", async () => {
    uploadDocument.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5"));
    const res = await upload(as("owner.token.sig"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.5");
  });

  it("refuses an origin that is not the frontend, without running the route", async () => {
    const res = await upload({ authorization: "Bearer owner.token.sig", origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it("answers the browser's preflight, and refuses a method it does not have", async () => {
    const pre = await app(
      new Request("http://localhost:4000/api/kb/documents", {
        method: "OPTIONS",
        headers: { origin: FRONTEND, "access-control-request-method": "POST", "access-control-request-headers": "authorization,x-pakka-tenant" },
      }),
    );
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    const get = await app(new Request("http://localhost:4000/api/kb/documents", { method: "GET", headers: as("owner.token.sig") }));
    expect(get.status).toBe(405);
  });

  it("has a 6 MB body limit, and the delete route keeps the default", () => {
    expect(bodyLimitFor("/api/kb/documents")).toBe(6 * 1024 * 1024);
    expect(bodyLimitFor("/api/kb/documents/e2000000-0000-0000-0000-0000000000a1")).toBeLessThan(6 * 1024 * 1024);
  });
});

describe("DELETE /api/kb/documents/:id", () => {
  const ID = "e2000000-0000-0000-0000-0000000000a1";
  const del = (headers: Record<string, string>, id = ID) => app(new Request(`http://localhost:4000/api/kb/documents/${id}`, { method: "DELETE", headers }));

  it("answers 204 with no body, for the member's business, with the id from the path", async () => {
    deleteDocument.mockResolvedValue(undefined);
    const res = await del(as("owner.token.sig"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(deleteDocument).toHaveBeenCalledWith(expect.objectContaining({ tenant: expect.objectContaining({ id: REALTY }) }), ID);
  });

  it("answers not_found in the envelope", async () => {
    deleteDocument.mockRejectedValue(new AppError("not_found", "That document was not found."));
    const res = await del(as("owner.token.sig"));
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
  });

  it("needs a signed-in member", async () => {
    expect((await del({ origin: FRONTEND })).status).toBe(401);
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it("allows the browser's preflight for DELETE", async () => {
    const pre = await app(
      new Request(`http://localhost:4000/api/kb/documents/${ID}`, {
        method: "OPTIONS",
        headers: { origin: FRONTEND, "access-control-request-method": "DELETE", "access-control-request-headers": "authorization,x-pakka-tenant" },
      }),
    );
    expect(pre.headers.get("access-control-allow-methods")).toContain("DELETE");
  });
});

describe("the real server with the real route table", () => {
  it("answers a declared body over 6 MB with the 413 envelope, readable from the frontend's origin, before the route runs", async () => {
    const server = createHttpServer(app, {
      log: () => {},
      maxBodyBytes: (path) => bodyLimitFor(path),
      onRejected: (req, res) => {
        const headers = new Headers(res.headers);
        headers.set("access-control-allow-origin", req.headers.get("origin") ?? "");
        return new Response(res.body, { status: res.status, headers });
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const answer = await new Promise<{ status: number; body: string; cors: string | undefined }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/api/kb/documents",
            method: "POST",
            headers: { "content-length": String(6 * 1024 * 1024 + 1), "content-type": "multipart/form-data; boundary=x", origin: FRONTEND, authorization: "Bearer owner.token.sig" },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk: Buffer) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body, cors: res.headers["access-control-allow-origin"] }));
          },
        );
        req.on("error", reject);
        req.write("x"); // the server answers on the header alone; the rest of the body is never sent
      });
      expect(answer.status).toBe(413);
      expect(answer.cors).toBe(FRONTEND);
      expect(JSON.parse(answer.body).error.code).toBe("validation_failed");
      expect(uploadDocument).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("audit: an uploaded or removed document names the member", () => {
  const DOC = "d0000000-0000-0000-0000-0000000000d1";

  it("records the upload and the removal, after they happen", async () => {
    uploadDocument.mockResolvedValue({ id: DOC, title: "Price list", sourceType: "upload", status: "processing", createdAt: "2026-10-08T10:00:00.000Z" });
    deleteDocument.mockResolvedValue(undefined);
    await upload(as("owner.token.sig"));
    await app(new Request(`http://localhost:4000/api/kb/documents/${DOC}`, { method: "DELETE", headers: as("owner.token.sig") }));
    expect(auditQuietly.mock.calls.map(([entry]) => entry)).toEqual([
      { tenantId: REALTY, actor: "user-owner@test.local", action: "kb.document_uploaded", entity: "kb_document", entityId: DOC },
      { tenantId: REALTY, actor: "user-owner@test.local", action: "kb.document_deleted", entity: "kb_document", entityId: DOC },
    ]);
  });

  it("records nothing when the service refused", async () => {
    uploadDocument.mockRejectedValue(new AppError("validation_failed", "Too big.", { file: "Pick a smaller file." }));
    deleteDocument.mockRejectedValue(new AppError("not_found", "Not found."));
    await upload(as("owner.token.sig"));
    await app(new Request(`http://localhost:4000/api/kb/documents/${DOC}`, { method: "DELETE", headers: as("owner.token.sig") }));
    expect(auditQuietly).not.toHaveBeenCalled();
  });
});

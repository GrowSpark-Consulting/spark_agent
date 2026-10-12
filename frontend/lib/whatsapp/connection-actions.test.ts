import type { ConnectionStatus, Role } from "@pakka/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendNoContent = vi.fn();
vi.mock("@/lib/api/client", () => ({ sendNoContent: (...args: unknown[]) => sendNoContent(...args) }));

const { CONNECTION_SERVICES, visibleActions } = await import("./connection-actions");

const STATUSES: ConnectionStatus[] = ["pending", "validating", "active", "failed", "disconnected"];
const ROLES: Role[] = ["owner", "admin", "staff"];
const CONNECTION = "30000000-0000-0000-0000-000000000001";
const TENANT = "10000000-0000-0000-0000-000000000003";

describe("visibleActions", () => {
  it("gives the owner recheck and disconnect on a working or broken connection", () => {
    expect(visibleActions("active", "owner", "embedded_signup")).toEqual(["recheck", "disconnect"]);
    expect(visibleActions("failed", "owner", "embedded_signup")).toEqual(["recheck", "disconnect"]);
    expect(visibleActions("pending", "owner", "embedded_signup")).toEqual(["recheck", "disconnect"]);
  });

  it("offers no recheck while checks run, and nothing once disconnected", () => {
    expect(visibleActions("validating", "owner", "embedded_signup")).toEqual(["disconnect"]);
    expect(visibleActions("disconnected", "owner", "embedded_signup")).toEqual([]);
  });

  it("lets an admin recheck but not disconnect, and staff do neither", () => {
    expect(visibleActions("active", "admin", "embedded_signup")).toEqual(["recheck"]);
    expect(visibleActions("active", "staff", "embedded_signup")).toEqual([]);
    expect(visibleActions("failed", "staff", "embedded_signup")).toEqual([]);
  });

  it("treats every client connection method the same", () => {
    for (const status of STATUSES) {
      for (const role of ROLES) {
        const expected = visibleActions(status, role, "embedded_signup");
        expect(visibleActions(status, role, "assisted")).toEqual(expected);
        expect(visibleActions(status, role, "manual_byo")).toEqual(expected);
      }
    }
  });

  it("offers nothing on a Spark Agent number (platform), whoever looks and whatever its status", () => {
    // Our own test or demo number, seeded by script: recheck and disconnect are for the client's own.
    for (const status of STATUSES) {
      for (const role of ROLES) expect(visibleActions(status, role, "platform")).toEqual([]);
    }
  });
});

describe("CONNECTION_SERVICES", () => {
  // A block body: a beforeEach that returns the mock would have vitest call it again as a cleanup.
  beforeEach(() => {
    sendNoContent.mockReset().mockResolvedValue(undefined);
  });

  it("recheck POSTs with no body to this connection's recheck route, for this business", async () => {
    await CONNECTION_SERVICES.recheck({ connectionId: CONNECTION, tenantId: TENANT });
    expect(sendNoContent).toHaveBeenCalledTimes(1);
    expect(sendNoContent).toHaveBeenCalledWith(`/api/whatsapp/connections/${CONNECTION}/recheck`, "POST", { tenantId: TENANT });
  });

  it("disconnect POSTs with no body to this connection's disconnect route, for this business", async () => {
    await CONNECTION_SERVICES.disconnect({ connectionId: CONNECTION, tenantId: TENANT });
    expect(sendNoContent).toHaveBeenCalledWith(`/api/whatsapp/connections/${CONNECTION}/disconnect`, "POST", { tenantId: TENANT });
  });

  it("encodes the id, so a hostile one can't change the path", async () => {
    await CONNECTION_SERVICES.recheck({ connectionId: "../x?y=1", tenantId: TENANT });
    expect(sendNoContent.mock.calls[0][0]).toBe("/api/whatsapp/connections/..%2Fx%3Fy%3D1/recheck");
  });

  it("lets the API's error through, so the screen can show it", async () => {
    const err = new Error("conflict");
    sendNoContent.mockImplementation(() => Promise.reject(err));
    const thrown = await CONNECTION_SERVICES.disconnect({ connectionId: CONNECTION, tenantId: TENANT }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBe(err);
  });
});

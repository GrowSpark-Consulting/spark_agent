import { describe, expect, it } from "vitest";
import { ALL_EVENTS, canManageWebhook, failureText, formProblems, hintText, orderedEvents, sameEvents, testResultText } from "./webhook-view";

describe("canManageWebhook", () => {
  it("is for owners and admins, not staff", () => {
    expect(canManageWebhook("owner")).toBe(true);
    expect(canManageWebhook("admin")).toBe(true);
    expect(canManageWebhook("staff")).toBe(false);
  });
});

describe("failureText", () => {
  it("words each reason the server gives", () => {
    expect(failureText(null)).toBeNull();
    expect(failureText("http_500")).toBe("The receiver answered with an error (HTTP 500).");
    expect(failureText("timeout")).toMatch(/too long/);
    expect(failureText("refused_address")).toMatch(/private or reserved/);
    expect(failureText("connection_failed")).toMatch(/couldn't connect/);
  });
  it("never repeats an unknown reason back", () => {
    expect(failureText("boom: secret=whsec_abc")).toBe("The last delivery didn't go through.");
  });
});

describe("testResultText", () => {
  it("uses only the fields of the real answer", () => {
    expect(testResultText({ delivered: true, status: 204, error: null })).toEqual({ ok: true, text: "Delivered. The receiver answered HTTP 204." });
    expect(testResultText({ delivered: true, status: null, error: null })).toEqual({ ok: true, text: "Delivered." });
    expect(testResultText({ delivered: false, status: 502, error: "http_502" })).toEqual({ ok: false, text: "Not delivered. The receiver answered with an error (HTTP 502)." });
    expect(testResultText({ delivered: false, status: null, error: "timeout" }).text).toMatch(/^Not delivered\. The receiver took too long/);
    expect(testResultText({ delivered: false, status: null, error: null }).ok).toBe(false);
  });
});

describe("formProblems", () => {
  it("asks for an address and at least one event, and leaves the address rules to the server", () => {
    expect(formProblems("", [])).toEqual({ url: expect.stringMatching(/Enter the address/), events: "Choose at least one event." });
    expect(formProblems("  ", ["lead.created"]).url).toBeDefined();
    expect(formProblems("http://not-https.example", ["lead.created"])).toEqual({});
    expect(formProblems(`https://example.com/${"a".repeat(500)}`, ["lead.created"]).url).toMatch(/500/);
  });
});

describe("events", () => {
  it("orders by the server's list and compares as sets", () => {
    expect(orderedEvents(["handoff.opened", "lead.created"])).toEqual(["lead.created", "handoff.opened"]);
    expect(sameEvents(["handoff.opened", "lead.created"], ["lead.created", "handoff.opened"])).toBe(true);
    expect(sameEvents(["lead.created"], ["lead.created", "handoff.opened"])).toBe(false);
    expect(ALL_EVENTS).toHaveLength(5);
  });
});

describe("hintText", () => {
  it("shows only the last characters", () => {
    expect(hintText("a1b2")).toBe("Signing secret ending in a1b2");
  });
});

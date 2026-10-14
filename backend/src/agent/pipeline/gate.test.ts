import { describe, expect, it } from "vitest";
import { decideGate, isAnswerable, isReadable, SUPPORTED_KINDS, type GateInput } from "./gate";

// Step 3 of the pipeline: should the AI answer this conversation at all, and which of the customer's messages
// can it read? Plain code (docs/handover.md, "code decides"). A message the gate turns away is not lost: it stays
// in the inbox for a person.

const open: GateInput = { optedOut: false, mode: "ai", featureEnabled: true };

describe("decideGate (the conversation)", () => {
  it("lets a conversation through when the AI is on, the chat is in AI mode and the customer has not opted out", () => {
    expect(decideGate(open)).toEqual({ open: true });
  });

  it("turns away a customer who opted out", () => {
    expect(decideGate({ ...open, optedOut: true })).toEqual({ open: false, reason: "opted_out" });
  });

  it.each(["human", "external"] as const)("turns away a chat in %s mode: a person has it", (mode) => {
    expect(decideGate({ ...open, mode })).toEqual({ open: false, reason: "not_ai_mode" });
  });

  it("turns away a business that has the AI auto-reply switched off, or not in its plan", () => {
    expect(decideGate({ ...open, featureEnabled: false })).toEqual({ open: false, reason: "feature_off" });
  });

  it.each(["ai_spend_cap", "tenant_rate_limit", "contact_rate_limit"] as const)("turns away a chat that reached a limit: %s", (limit) => {
    expect(decideGate({ ...open, limit })).toEqual({ open: false, reason: limit });
    expect(decideGate({ ...open, limit: null })).toEqual({ open: true });
  });

  it("names a limit after the other reasons: an opt-out, a person's chat or the switch says more", () => {
    expect(decideGate({ ...open, featureEnabled: false, limit: "ai_spend_cap" })).toEqual({ open: false, reason: "feature_off" });
    expect(decideGate({ ...open, optedOut: true, limit: "contact_rate_limit" })).toEqual({ open: false, reason: "opted_out" });
  });

  it("names the strongest reason first: opted out, then a person's chat, then the switch", () => {
    const all: GateInput = { optedOut: true, mode: "human", featureEnabled: false };
    expect(decideGate(all)).toEqual({ open: false, reason: "opted_out" });
    expect(decideGate({ ...all, optedOut: false })).toEqual({ open: false, reason: "not_ai_mode" });
    expect(decideGate({ ...all, optedOut: false, mode: "ai" })).toEqual({ open: false, reason: "feature_off" });
  });
});

describe("isAnswerable (one message): what the assistant replies to, which is more than what it can read", () => {
  it.each(["text", "interactive", null])("%s is answered", (kind) => {
    expect(isAnswerable(kind)).toBe(true);
  });

  it("a voice note is answered (with a polite request to type), though it cannot be read", () => {
    expect(isAnswerable("audio")).toBe(true);
    expect(isReadable("audio")).toBe(false);
  });

  it.each(["image", "location", "document", "unsupported"])("a %s is left for staff", (kind) => {
    expect(isAnswerable(kind)).toBe(false);
  });
});

describe("isReadable (one message)", () => {
  it.each(["text", "interactive", null])("the agent can read a message of kind %s", (kind) => {
    expect(isReadable(kind)).toBe(true);
  });

  it.each(["image", "audio", "location", "document", "unsupported"])("the agent cannot read a %s message yet", (kind) => {
    expect(isReadable(kind)).toBe(false);
  });

  it("the supported kinds are text and tapped replies", () => {
    expect([...SUPPORTED_KINDS].sort()).toEqual(["interactive", "text"]);
  });
});

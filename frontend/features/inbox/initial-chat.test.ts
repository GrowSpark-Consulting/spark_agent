import { describe, expect, it } from "vitest";
import { initialChatIdFrom } from "./initial-chat";

const A = "40000000-0000-0000-0000-000000000001";
const B = "40000000-0000-0000-0000-000000000002";

describe("initialChatIdFrom", () => {
  it("reads ?chat= (what the app and the takeover link write)", () => {
    expect(initialChatIdFrom({ chat: A })).toBe(A);
  });

  it("reads ?conversation= (what staff alerts link to)", () => {
    expect(initialChatIdFrom({ conversation: A })).toBe(A);
  });

  it("lets chat win when both are valid", () => {
    expect(initialChatIdFrom({ chat: A, conversation: B })).toBe(A);
  });

  it("falls back to conversation when chat is not a GUID", () => {
    expect(initialChatIdFrom({ chat: "nope", conversation: B })).toBe(B);
  });

  it("takes the first value of a repeated parameter", () => {
    expect(initialChatIdFrom({ conversation: [A, B] })).toBe(A);
    expect(initialChatIdFrom({ chat: [B, A] })).toBe(B);
  });

  it("ignores missing, empty and malformed values", () => {
    expect(initialChatIdFrom({})).toBeNull();
    expect(initialChatIdFrom({ chat: "", conversation: "" })).toBeNull();
    expect(initialChatIdFrom({ chat: "../../etc", conversation: "123" })).toBeNull();
    expect(initialChatIdFrom({ chat: [], conversation: [] })).toBeNull();
    expect(initialChatIdFrom({ conversation: `${A}'; drop table` })).toBeNull();
  });
});

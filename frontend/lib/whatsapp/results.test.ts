import { describe, expect, it } from "vitest";
import { readTemplateResult, readTestMessageResult, ResultDataError, unconfirmedFailure } from "./results";

// What the template and test-message forms accept as "it worked". Before this, any 2xx body was taken as success, so a
// mismatched deploy or a proxy answering 200 with other JSON would have shown "WhatsApp accepted the message (ID undefined)".

describe("a test message's answer", () => {
  it("is accepted when WhatsApp took it, with the id it gave", () => {
    expect(readTestMessageResult({ providerMsgId: "wamid.ABC", status: "accepted" })).toEqual({ providerMsgId: "wamid.ABC", status: "accepted" });
  });

  it("is refused when the id is missing or empty, the status isn't accepted, or it isn't an object", () => {
    for (const bad of [{}, { status: "accepted" }, { providerMsgId: "", status: "accepted" }, { providerMsgId: "x", status: "queued" }, { providerMsgId: 5, status: "accepted" }, null, "ok", []]) {
      expect(() => readTestMessageResult(bad)).toThrow(ResultDataError);
    }
  });
});

describe("a template's answer", () => {
  it("is accepted as pending (sent to Meta) or draft (only saved)", () => {
    expect(readTemplateResult({ id: "t1", name: "booking_confirmed_v1", language: "en", status: "pending" }).status).toBe("pending");
    expect(readTemplateResult({ id: "t1", name: "booking_confirmed_v1", language: "ta", status: "draft" }).language).toBe("ta");
  });

  it("is refused when anything it would show is missing or unknown, so the page never says 'undefined (undefined)'", () => {
    const ok = { id: "t1", name: "n", language: "en", status: "pending" };
    for (const bad of [{ ...ok, id: undefined }, { ...ok, name: "" }, { ...ok, language: "fr" }, { ...ok, status: "approved" }, {}, null, 3]) {
      expect(() => readTemplateResult(bad)).toThrow(ResultDataError);
    }
  });
});

describe("what the page says when the answer can't be read", () => {
  it("does not claim success or failure: it may have gone through, so it says to check before trying again", () => {
    const message = unconfirmedFailure(new ResultDataError("test message"));
    expect(message).toMatchObject({ code: "internal", retryable: false });
    expect(message.title).toMatch(/confirm/i);
    expect(message.message).toMatch(/check/i);
    expect(unconfirmedFailure(new ResultDataError("template")).message).toMatch(/template/i);
  });
});

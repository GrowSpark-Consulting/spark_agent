import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

const postJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ postJson: (...args: unknown[]) => postJson(...args) }));

const { languageLabel, placeSuggestion, requestSuggestion, SuggestionDataError, suggestionFailure } = await import("./suggest-reply");

const CONV = "40000000-0000-0000-0000-000000000001";
const TENANT = "10000000-0000-0000-0000-000000000004";

// A block body: a beforeEach that returns the mock would have vitest call it again as a cleanup.
beforeEach(() => {
  postJson.mockReset();
});

describe("requestSuggestion", () => {
  it("POSTs with no body to this conversation's suggest route, for this business", async () => {
    postJson.mockResolvedValue({ reply: "Sure, 4 pm works.", language: "en", reason: null });
    await requestSuggestion(TENANT, CONV);
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledWith(`/api/conversations/${CONV}/suggest`, undefined, { tenantId: TENANT });
  });

  it("encodes the id, so a hostile one can't change the path", async () => {
    postJson.mockResolvedValue({ reply: "x", language: null, reason: null });
    await requestSuggestion(TENANT, "../x?y=1");
    expect(postJson.mock.calls[0][0]).toBe("/api/conversations/..%2Fx%3Fy%3D1/suggest");
  });

  it("returns the reply and the customer's language", async () => {
    postJson.mockResolvedValue({ reply: "  Sure, 4 pm works.  ", language: "ta-en", reason: null });
    expect(await requestSuggestion(TENANT, CONV)).toEqual({ kind: "reply", reply: "Sure, 4 pm works.", language: "ta-en" });
  });

  it("treats reply: null, reason: unavailable as no suggestion, not an error", async () => {
    postJson.mockResolvedValue({ reply: null, language: "en", reason: "unavailable" });
    expect(await requestSuggestion(TENANT, CONV)).toEqual({ kind: "unavailable" });
  });

  it("treats a blank reply as no suggestion", async () => {
    postJson.mockResolvedValue({ reply: "   ", language: null, reason: null });
    expect(await requestSuggestion(TENANT, CONV)).toEqual({ kind: "unavailable" });
  });

  it.each([
    ["no fields", {}],
    ["a number for the reply", { reply: 4, language: null, reason: null }],
    ["a reason outside the contract", { reply: null, language: null, reason: "rate_limited" }],
    ["null", null],
    ["a string", "ok"],
  ])("throws SuggestionDataError for %s", async (_name, answer) => {
    postJson.mockResolvedValue(answer);
    await expect(requestSuggestion(TENANT, CONV)).rejects.toBeInstanceOf(SuggestionDataError);
  });

  it("passes the API's error on", async () => {
    const err = new ApiError(404, { error: { code: "not_found", message: "That conversation was not found." } });
    postJson.mockImplementation(() => Promise.reject(err));
    const thrown = await requestSuggestion(TENANT, CONV).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBe(err);
  });
});

describe("suggestionFailure", () => {
  it("uses the API's own message for an API error", () => {
    const err = new ApiError(404, { error: { code: "not_found", message: "That conversation was not found." } });
    expect(suggestionFailure(err)).toMatchObject({ code: "not_found", message: "That conversation was not found." });
  });

  it("says the answer couldn't be read for a malformed one", () => {
    expect(suggestionFailure(new SuggestionDataError())).toMatchObject({ message: "The suggestion came back in a form we couldn't read." });
  });

  it("never shows raw text from an unknown error", () => {
    expect(JSON.stringify(suggestionFailure(new Error("connect ECONNREFUSED password=hunter2")))).not.toMatch(/ECONNREFUSED|hunter2/);
  });
});

describe("placeSuggestion", () => {
  it("fills an empty or blank draft", () => {
    expect(placeSuggestion("")).toBe("fill");
    expect(placeSuggestion("  \n ")).toBe("fill");
  });

  it("asks before replacing anything the staff member typed", () => {
    expect(placeSuggestion("Hello")).toBe("ask");
    expect(placeSuggestion(" a ")).toBe("ask");
  });
});

describe("languageLabel", () => {
  it("names the languages we have, and nothing else", () => {
    expect(languageLabel("en")).toBe("English");
    expect(languageLabel("ta")).toBe("Tamil");
    expect(languageLabel("ta-en")).toBe("Tanglish");
    expect(languageLabel("hi")).toBe("Hindi");
    expect(languageLabel("ml")).toBe("Malayalam");
    expect(languageLabel(null)).toBeNull();
    expect(languageLabel("xx")).toBeNull();
    expect(languageLabel("toString")).toBeNull();
  });
});

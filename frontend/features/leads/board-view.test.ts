import { describe, expect, it } from "vitest";
import { chipLabel, headingText, stageCountLabel, truncationNotice } from "./board-view";
import type { LeadCounts } from "./data";

// The numbers and sentences the Leads board shows, as pure functions: what counts as exact, what says "+", and what is left
// out when a number isn't known (nothing is ever worked out from the leads on screen when the database could not count).

const COUNTS: LeadCounts = { total: 1234, open: 900, hot: 300, warm: 400, cold: 400, disqualified: 100, unscored: 34 };

describe("a stage column's count", () => {
  it("is the number of leads loaded when every lead matching is loaded", () => {
    expect(stageCountLabel({ loaded: 12, truncated: false, exact: undefined })).toBe("12");
    expect(stageCountLabel({ loaded: 0, truncated: false, exact: undefined })).toBe("0");
  });

  it("is the database's count when the list is cut short, with how many of them are on screen", () => {
    expect(stageCountLabel({ loaded: 37, truncated: true, exact: 412 })).toBe("37 of 412");
    expect(stageCountLabel({ loaded: 37, truncated: true, exact: 37 })).toBe("37");
  });

  it("is a minimum, with a plus, while the database's count is not known", () => {
    expect(stageCountLabel({ loaded: 37, truncated: true, exact: undefined })).toBe("37+");
  });
});

describe("a filter chip", () => {
  it("shows the whole business's number for it", () => {
    expect(chipLabel("All", COUNTS.total)).toBe("All · 1234");
    expect(chipLabel("Hot", COUNTS.hot)).toBe("Hot · 300");
  });

  it("shows no number at all when the counts could not be read", () => {
    expect(chipLabel("Hot", null)).toBe("Hot");
  });
});

describe("the page heading", () => {
  it("says how many are open and how many hot, over the whole business", () => {
    expect(headingText(COUNTS)).toBe("900 open · 300 hot");
  });

  it("falls back to the plain line when the counts are not known", () => {
    expect(headingText(null)).toBe("Every WhatsApp enquiry, by stage.");
  });
});

describe("the notice that the list is cut short", () => {
  it("says how many of how many are shown", () => {
    expect(truncationNotice({ loaded: 200, total: 1234, filtering: false })).toBe("Showing 200 of 1234 leads, most recently updated first.");
    expect(truncationNotice({ loaded: 200, total: 312, filtering: true })).toBe("Showing 200 of 312 matching leads, most recently updated first.");
  });

  it("does not claim a total it doesn't have", () => {
    expect(truncationNotice({ loaded: 200, total: null, filtering: false })).toBe("Showing the 200 most recently updated leads. Load more to see older ones.");
    expect(truncationNotice({ loaded: 200, total: null, filtering: true })).toBe("Showing the 200 most recently updated matching leads. Load more to see older ones.");
  });
});

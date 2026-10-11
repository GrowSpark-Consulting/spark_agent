import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TEMPERATURE_STYLE, TEMPERATURES } from "./data";
import { ScoreBadge } from "./score-badge";

// The badge shows the stored temperature and score and never bands a score itself. Rendered to static markup (react-dom/server):
// the unit suite has no DOM, so this checks the words and the styling hooks, not the browser layout (Playwright covers that,
// against mocked data).

const render = (props: ComponentProps<typeof ScoreBadge>) => renderToStaticMarkup(createElement(ScoreBadge, props));
/** The visible words: tags removed, runs of whitespace collapsed. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("ScoreBadge, small", () => {
  it.each([
    ["hot", 82, "Hot 82"],
    ["warm", 55, "Warm 55"],
    ["cold", 20, "Cold 20"],
    ["disqualified", 12, "Disqualified 12"],
  ] as const)("%s with score %s reads %j", (temperature, score, text) => {
    const html = render({ temperature, score });
    expect(words(html)).toBe(text);
    expect(html).toContain('data-testid="score-badge"');
  });

  it("shows a temperature with no score on its own", () => {
    expect(words(render({ temperature: "hot", score: null }))).toBe("Hot");
    expect(words(render({ temperature: "disqualified", score: null }))).toBe("Disqualified");
  });

  it("shows a score of zero rather than hiding it", () => {
    expect(words(render({ temperature: "cold", score: 0 }))).toBe("Cold 0");
    expect(words(render({ temperature: null, score: 0 }))).toBe("Score 0");
  });

  it("shows a score with no temperature as a plain score, not a band", () => {
    expect(words(render({ temperature: null, score: 95 }))).toBe("Score 95");
    expect(words(render({ temperature: null, score: 95 }))).not.toMatch(/hot|warm|cold/i);
  });

  it("shows no score and no temperature as not scored, or the caller's words", () => {
    expect(words(render({ temperature: null, score: null }))).toBe("Not scored");
    expect(words(render({ temperature: null, score: null, unscoredLabel: "Waiting for answers" }))).toBe("Waiting for answers");
  });

  it("ignores the caller's words when there is a temperature or a score", () => {
    expect(words(render({ temperature: "warm", score: null, unscoredLabel: "Waiting" }))).toBe("Warm");
    expect(words(render({ temperature: null, score: 40, unscoredLabel: "Waiting" }))).toBe("Score 40");
  });

  it("uses the stored temperature's colours, and an outline only when there is none", () => {
    for (const t of TEMPERATURES) {
      expect(render({ temperature: t, score: 50 })).toContain(`background:${TEMPERATURE_STYLE[t].bg}`);
      expect(render({ temperature: t, score: 50 })).not.toContain("1px solid");
    }
    expect(render({ temperature: null, score: null })).toContain("1px solid");
    expect(render({ temperature: null, score: 50 })).toContain("1px solid");
  });
});

describe("ScoreBadge, large (lead detail)", () => {
  it("shows the score big and the temperature under it", () => {
    expect(words(render({ temperature: "hot", score: 82, large: true }))).toBe("82 Hot");
    expect(words(render({ temperature: "disqualified", score: 12, large: true }))).toBe("12 Disqualified");
  });

  it("shows a dash for a missing score, and zero as zero", () => {
    expect(words(render({ temperature: "warm", score: null, large: true }))).toBe("— Warm");
    expect(words(render({ temperature: "cold", score: 0, large: true }))).toBe("0 Cold");
  });

  it("shows a score with no temperature as Score, and nothing at all as not scored", () => {
    expect(words(render({ temperature: null, score: 70, large: true }))).toBe("70 Score");
    expect(words(render({ temperature: null, score: null, large: true }))).toBe("— Not scored");
  });
});

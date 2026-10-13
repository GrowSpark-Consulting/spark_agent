import { describe, expect, it } from "vitest";
import { formatMs, formatReport, percentile, Recorder, stageRows, type ReportInput } from "./latency-report";

// The latency harness's numbers: nearest-rank percentiles, the tables, and above all the labels. Every number in the report says whether it was mocked,
// live, read from the configuration or not measured at all.

describe("percentile", () => {
  it("is the nearest-rank value: the smallest one at least p percent of the values are not above", () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile(values, 100)).toBe(10);
    expect(percentile(values, 0)).toBe(1);
  });

  it("copes with one value, and with none (NaN, never a made-up zero)", () => {
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });

  it("does not change the list it is given", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("the recorder", () => {
  it("keeps every timing under its stage name, and the turns apart from them", () => {
    const r = new Recorder();
    r.record("llm:extraction", 5);
    r.record("llm:extraction", 7);
    r.record("send", 1);
    r.turn?.(0, 30);
    r.turn?.(1, 40);
    expect(r.samples.get("llm:extraction")).toEqual([5, 7]);
    expect(r.samples.get("send")).toEqual([1]);
    expect(r.turns).toEqual([30, 40]);
  });

  it("rows by stage: how many, the median, the 95th percentile and the largest", () => {
    const r = new Recorder();
    for (const ms of [10, 20, 30, 40]) r.record("step:extract", ms);
    r.record("step:reply", 100);
    r.record("send", 3);
    expect(stageRows(r.samples, "step:")).toEqual([
      { stage: "extract", n: 4, p50: 20, p95: 40, max: 40 },
      { stage: "reply", n: 1, p50: 100, p95: 100, max: 100 },
    ]);
    expect(stageRows(r.samples, "send")).toEqual([{ stage: "send", n: 1, p50: 3, p95: 3, max: 3 }]);
  });
});

const recorder = () => {
  const r = new Recorder();
  for (let i = 0; i < 20; i++) {
    r.turn?.(i, 2 + i);
    r.record("step:extract", 1);
    r.record("step:reply", 1);
    r.record("llm:extraction", 0.5);
    r.record("llm:reply", 0.5);
    r.record("send", 0.1);
  }
  return r;
};
const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  mode: "mocked",
  chats: 3,
  turns: 20,
  rounds: 1,
  recorder: recorder(),
  stepsPerTurn: 6.5,
  regenerations: 0,
  postcheck: { n: 100, p50Us: 12, p95Us: 30 },
  calls: null,
  capped: false,
  config: [{ what: "Hard stop", value: "25 s" }],
  ...over,
});
const text = (over: Partial<ReportInput> = {}) => formatReport(input(over)).join("\n");

describe("the report", () => {
  it("says in its first lines whether it is mocked or live, and what that means", () => {
    expect(text()).toMatch(/^MOCKED/);
    expect(text()).toMatch(/models answer at once/);
    expect(text()).toMatch(/nothing is sent/);
    expect(text({ mode: "live", calls: { used: 9, max: 15, byRole: { extraction: 5, reply: 4 }, costUsd: 0.01 } })).toMatch(/^LIVE/);
  });

  it("labels every table with where its numbers come from", () => {
    const t = text();
    for (const heading of ["Whole turn [MOCKED]", "By step [MOCKED]", "Calls inside the steps [MOCKED]", "Post-check [MEASURED SEPARATELY]", "Configured limits [CONFIG]", "Not measured here [NOT MEASURED]"]) {
      expect(t).toContain(heading);
    }
    const live = text({ mode: "live", calls: { used: 9, max: 15, byRole: {}, costUsd: null } });
    expect(live).toContain("Whole turn [LIVE]");
    expect(live).toContain("Calls inside the steps [LIVE: the models; everything else mocked]");
  });

  it("the whole-turn table has the count, the median, the 95th percentile, the largest and how many turns went past the 10 s target and the 25 s hard stop", () => {
    const r = new Recorder();
    for (const ms of [1000, 2000, 11_000, 26_000]) r.turn?.(0, ms);
    const t = text({ recorder: r, turns: 4 });
    expect(t).toMatch(/turns\s+4/);
    expect(t).toMatch(/over 10 s\s+2/);
    expect(t).toMatch(/over 25 s\s+1/);
  });

  it("shows durations in units a person can read", () => {
    expect(formatMs(0.04)).toBe("0.04 ms");
    expect(formatMs(3.456)).toBe("3.5 ms");
    expect(formatMs(12.3)).toBe("12 ms");
    expect(formatMs(999)).toBe("999 ms");
    expect(formatMs(1500)).toBe("1.5 s");
    expect(formatMs(Number.NaN)).toBe("-");
    const r = new Recorder();
    for (const ms of [0.04, 12.3, 1500]) r.turn?.(0, ms);
    const t = text({ recorder: r, turns: 3 });
    expect(t).toMatch(/p50\s+12 ms/);
    expect(t).toMatch(/max\s+1\.5 s/);
  });

  it("reports the steps per turn, the regenerations of the reply and the post-check on its own", () => {
    const t = text({ stepsPerTurn: 7.25, regenerations: 2 });
    expect(t).toMatch(/steps per turn \(run by this harness\)\s+7\.25/);
    expect(t).toMatch(/reply regenerated after the post-check\s+2/);
    expect(t).toMatch(/12 µs/);
  });

  it("lists what is not measured: the wait before the run, Inngest's own time per step (and that the real run has about 6 more steps), the real database and the real send", () => {
    const t = text();
    expect(t).toMatch(/about 6 more steps/);
    expect(t).toMatch(/debounce/i);
    expect(t).toMatch(/per-step/i);
    expect(t).toMatch(/database/i);
    expect(t).toMatch(/Meta/);
  });

  it("a live run shows the requests used against the cap, by role, and says when the cap was reached", () => {
    const live = text({ mode: "live", calls: { used: 15, max: 15, byRole: { extraction: 8, reply: 7 }, costUsd: 0.0123 }, capped: true });
    expect(live).toMatch(/requests\s+15 of 15/);
    expect(live).toMatch(/extraction 8/);
    expect(live).toMatch(/reply 7/);
    expect(live).toMatch(/cap was reached/i);
    expect(live).toMatch(/\$0\.0123/);
  });

  it("holds no message text, number or id: only stage names and durations", () => {
    const t = text();
    expect(t).not.toMatch(/\+91|wamid|e0000000|@/);
  });

  it("with nothing recorded, says so instead of printing NaN", () => {
    const t = text({ recorder: new Recorder(), turns: 0 });
    expect(t).not.toMatch(/NaN/);
    expect(t).toMatch(/no turns/i);
  });
});

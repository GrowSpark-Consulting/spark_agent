import { describe, expect, it, vi } from "vitest";
import { createRefusalLog } from "./refusal-log";

// The line that says why the webhook refused a request. Fixed reason codes and counts only, and at most one line per reason per window, so
// a scanner hitting the route cannot flood the logs.

function setup(windowMs = 60_000) {
  let clock = 1_000_000;
  const lines: string[] = [];
  const log = createRefusalLog({ now: () => clock, windowMs, write: (line) => lines.push(line) });
  return { log, lines, advance: (ms: number) => (clock += ms) };
}

describe("refusal log", () => {
  it("writes one fixed line with the reason and the counts", () => {
    const { log, lines } = setup();
    log.refused("byo_signature_mismatch", { phoneIds: 1, byoRows: 2, byoUndecryptable: 1 });
    expect(lines).toEqual(["[whatsapp-webhook] refused reason=byo_signature_mismatch phone_ids=1 byo_rows=2 byo_undecryptable=1 suppressed=0"]);
  });

  it("counts default to 0 for a reason that is decided before the body is read", () => {
    const { log, lines } = setup();
    log.refused("no_signature_header");
    expect(lines).toEqual(["[whatsapp-webhook] refused reason=no_signature_header phone_ids=0 byo_rows=0 byo_undecryptable=0 suppressed=0"]);
  });

  it("writes a reason once per window and reports how many it held back on the next line", () => {
    const { log, lines, advance } = setup();
    log.refused("bad_signature_format");
    for (let i = 0; i < 5; i++) log.refused("bad_signature_format");
    expect(lines).toHaveLength(1);
    advance(60_000);
    log.refused("bad_signature_format");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("suppressed=5");
    advance(60_000);
    log.refused("bad_signature_format");
    expect(lines[2]).toContain("suppressed=0");
  });

  it("limits each reason on its own, so one noisy reason never hides another", () => {
    const { log, lines } = setup();
    log.refused("bad_signature_format");
    log.refused("bad_signature_format");
    log.refused("no_byo_connection");
    expect(lines.map((l) => l.match(/reason=(\w+)/)?.[1])).toEqual(["bad_signature_format", "no_byo_connection"]);
  });

  it("keeps nothing but the five fixed reasons and numbers in a line", () => {
    const { log, lines } = setup();
    for (const reason of ["no_signature_header", "bad_signature_format", "body_not_json", "no_byo_connection", "byo_signature_mismatch"] as const) log.refused(reason, { phoneIds: 3 });
    for (const line of lines) expect(line).toMatch(/^\[whatsapp-webhook\] refused reason=[a-z_]+ phone_ids=\d+ byo_rows=\d+ byo_undecryptable=\d+ suppressed=\d+$/);
  });

  it("writes at warn level by default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createRefusalLog().refused("body_not_json");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

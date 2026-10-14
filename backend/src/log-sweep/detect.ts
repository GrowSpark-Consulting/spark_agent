import { format } from "node:util";
import { vi, type MockInstance } from "vitest";

// The log sweep (Day 7, PR B): proves no phone number, token, app secret or message text appears in a log line. Two parts: capturing every line the code
// logs (console.log, error, warn, info, debug, and the `log` callbacks the server and the error envelope take), and looking for what must never be there.
//
// EVERY secret, phone number and text used with this is a SYNTHETIC value made in the test. Nothing here reads an environment file.
//
// What it looks for:
//   phone   a phone-shaped run of digits (10 to 15, optional +, single spaces or dashes between digits: the shape agent/llm/mask.ts treats as a phone), after
//           removing the things that look like one and are not (UUIDs, ISO times), and every written form of the fixtures' own numbers
//   token   anything shaped like a credential (a JWT, a Meta EAA token, an Anthropic key, a Supabase key, a bearer header, any 32+ character run of
//           letters, digits, _ and -, which is the shape of a connect-link token, a signing secret or a key)
//   secret  the exact secrets of the fixtures, whatever their shape
//   text    the exact canary words planted in a customer's message, a reply, a knowledge-base chunk or a name
// A masked number (+9198xxxxxx21) and an id (a UUID) are fine.

export interface Fixtures {
  /** E.164 with the plus, for example "+919812345621". Every written form of each is looked for. */
  phones: string[];
  /** Exact secrets, whatever their shape. */
  secrets: string[];
  /** Exact words that must never be logged (canaries in message texts, names, replies, knowledge-base text). */
  texts: string[];
}

export type LeakKind = "phone" | "token" | "secret" | "text";
export interface Leak {
  kind: LeakKind;
  /** What matched (the leak itself: only ever a synthetic value). */
  match: string;
  line: string;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g;
/** The shape agent/llm/mask.ts calls a phone number: 10 to 15 digits, an optional +, single spaces or dashes between digits. */
const PHONE_SHAPE = /\+?(?<!\d)(?:\d[ -]?){9,14}\d(?!\d)/g;

const TOKEN_SHAPES: [string, RegExp][] = [
  ["a JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/],
  ["a Meta access token", /\bEAA[A-Za-z0-9]{20,}/],
  ["an Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{10,}/],
  ["a Supabase key", /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/],
  ["a bearer header", /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i],
  ["a connection string with a password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ["a long run of key characters", /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/],
];

/** The ways a number is written: E.164, without the plus, national (the last 10 digits), spaced and dashed. */
export function phoneForms(e164: string): string[] {
  const digits = e164.replace(/\D/g, "");
  const national = digits.slice(-10);
  const cc = digits.slice(0, digits.length - 10);
  const forms = new Set<string>([`+${digits}`, digits, national, `+${cc} ${national.slice(0, 5)} ${national.slice(5)}`, `+${cc}-${national.slice(0, 5)}-${national.slice(5)}`, `${national.slice(0, 5)} ${national.slice(5)}`, `${national.slice(0, 5)}-${national.slice(5)}`]);
  return [...forms].filter((f) => f.length >= 10);
}

/** Looks for leaks in lines of log. An empty array is the pass. */
export function findLeaks(lines: readonly string[], fixtures: Fixtures): Leak[] {
  const leaks: Leak[] = [];
  const forms = fixtures.phones.flatMap(phoneForms);
  for (const line of lines) {
    for (const form of forms) if (line.includes(form)) leaks.push({ kind: "phone", match: form, line });
    for (const secret of fixtures.secrets) if (line.includes(secret)) leaks.push({ kind: "secret", match: secret, line });
    for (const text of fixtures.texts) if (line.includes(text)) leaks.push({ kind: "text", match: text, line });
    // What looks like a phone or a token but is an id or a time is taken out first; the exact checks above ran on the whole line.
    const plain = line.replace(UUID, " ").replace(ISO_TIME, " ");
    for (const match of plain.match(PHONE_SHAPE) ?? []) leaks.push({ kind: "phone", match: match.trim(), line });
    for (const [, shape] of TOKEN_SHAPES) {
      const found = plain.match(shape)?.[0];
      if (found) leaks.push({ kind: "token", match: found, line });
    }
  }
  return dedupe(leaks);
}

function dedupe(leaks: Leak[]): Leak[] {
  const seen = new Set<string>();
  return leaks.filter((l) => {
    const key = `${l.kind}|${l.match}|${l.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A readable report of what leaked, for a failing assertion. Shows only the matched value and the line it was in. */
export function describeLeaks(leaks: readonly Leak[]): string {
  return leaks.map((l) => `${l.kind} ${JSON.stringify(l.match)} in: ${l.line.slice(0, 300)}`).join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------

export interface LogCapture {
  /** Every line logged since the capture started, in order, with the console method or callback it came through. */
  readonly entries: { source: string; line: string }[];
  /** Just the lines. */
  lines(): string[];
  /** A `log` callback for code that takes one (the request logger, the error envelope): lines it gets are captured too. */
  readonly log: (line: string) => void;
  /** Puts the console back. */
  stop(): void;
  /** Leaks found so far (an empty array is the pass). */
  leaks(fixtures: Fixtures): Leak[];
}

const METHODS = ["log", "error", "warn", "info", "debug"] as const;

/** Starts capturing everything the code writes with console.*. The lines are kept and NOT printed. Call stop() (or restore mocks) when done. */
export function captureLogs(): LogCapture {
  const entries: { source: string; line: string }[] = [];
  const spies: MockInstance[] = METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      entries.push({ source: `console.${method}`, line: format(...args) });
    }),
  );
  const capture: LogCapture = {
    entries,
    lines: () => entries.map((e) => e.line),
    log: (line) => void entries.push({ source: "log callback", line }),
    stop: () => spies.forEach((spy) => spy.mockRestore()),
    leaks: (fixtures) => findLeaks(entries.map((e) => e.line), fixtures),
  };
  return capture;
}

/** An error message packed with things that must never be logged: what a provider, a database or a library can put in a message. */
export function poison(fixtures: Fixtures): string {
  return `upstream said: ${fixtures.phones[0] ?? ""} ${fixtures.secrets.join(" ")} ${fixtures.texts.join(" ")}`;
}

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The static guard's scanner (Day 7, PR B): finds every console.log / error / warn / info / debug call in the backend's own source and reports the ones that
// write something other than fixed words: an interpolation or an argument whose name says it could hold a phone number, a token, a secret or a customer's
// words, or an argument that is not a string at all (an error object prints its message and its stack). Text-based, not a parser of TypeScript: it knows
// strings, template literals with ${} nesting and comments, which is all a log call needs.

export const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Names that say a value could be personal or secret. Whole identifiers or whole words of a property path (messageId, tenantId and err.code do not match). */
const RISKY = /\b(?:phone|phones|token|tokens|secret|secrets|password|passwd|authorization|bearer|apikey|api_key|key|body|text|message|msg|content|name|email|from|to|wa_id|notes|note|comment|comments|address|summary|snippet|recipient|display|displayPhone|caption|answer|reply|question|detail|details|stack|error|err|e|input|output|payload|raw|request|response|url|href|path|query|headers|value|data|args)\b/i;

export interface LogCall {
  /** Path from the source root, with forward slashes. */
  file: string;
  line: number;
  method: string;
  /** The call as written (whitespace collapsed): its identity for the allowlist, stable when lines move. */
  text: string;
  /** Why it is flagged, one entry per risky piece. Empty: only fixed words and safe names. */
  flags: string[];
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      yield path;
    }
  }
}

const SKIP_DIRS = ["test-support", "conversation-tests", "log-sweep", "scripts", "__fixtures__"];
const skipped = (rel: string) => SKIP_DIRS.some((d) => rel.startsWith(`${d}/`)) || rel.endsWith("test-fixtures.ts");

/** Index just after the string or template literal that starts at `i`, plus the `${...}` expressions inside a template. */
function readLiteral(src: string, i: number): { end: number; expressions: string[] } {
  const quote = src[i];
  const expressions: string[] = [];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return { end: j + 1, expressions };
    if (quote === "`" && c === "$" && src[j + 1] === "{") {
      let depth = 1;
      let k = j + 2;
      const start = k;
      while (k < src.length && depth > 0) {
        const d = src[k];
        if (d === "'" || d === '"' || d === "`") {
          const inner = readLiteral(src, k);
          expressions.push(...inner.expressions);
          k = inner.end;
          continue;
        }
        if (d === "{") depth++;
        else if (d === "}") depth--;
        k++;
      }
      expressions.push(src.slice(start, k - 1));
      j = k;
      continue;
    }
    j++;
  }
  return { end: src.length, expressions };
}

/** Splits text at top-level `separator` characters: not inside a string, a template literal or brackets. */
function splitTop(text: string, separator: "," | "+"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === "`") {
      i = readLiteral(text, i).end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** Every `${}` expression of every string and template in a piece of code, and what is left of the code without them. */
function literalsIn(code: string): { expressions: string[]; remainder: string } {
  const expressions: string[] = [];
  let remainder = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"' || c === "`") {
      const lit = readLiteral(code, i);
      expressions.push(...lit.expressions);
      remainder += "''";
      i = lit.end;
      continue;
    }
    remainder += c;
    i++;
  }
  return { expressions, remainder };
}

/**
 * The pieces a call writes: its arguments split at top-level commas, each split again at top-level plus signs (`"a " + b`). A piece is either a plain string
 * (nothing interpolated), a template literal (the `${}` expressions in it), or something else (a variable, a call: it is not known what it holds).
 */
function arguments_(inner: string): { text: string; literal: boolean; expressions: string[] }[] {
  return splitTop(inner, ",").flatMap((argument) =>
    splitTop(argument, "+").map((text) => {
      if (!/^(['"`])/.test(text)) {
        // A conditional with strings in it ((a ? `x ${b}` : "y")): what it interpolates is checked like a template. A bare variable or call is opaque (no expressions).
        const inside = literalsIn(text);
        return { text, literal: false, expressions: inside.expressions, remainder: inside.remainder } as { text: string; literal: boolean; expressions: string[]; remainder?: string };
      }
      const lit = readLiteral(text, 0);
      // a literal followed by more (`"a"[0]`, `"a".repeat(3)`) is not only a literal
      if (lit.end < text.length) return { text, literal: false, expressions: [] as string[] };
      return { text, literal: lit.expressions.length === 0, expressions: lit.expressions };
    }),
  );
}

const stripLiterals = (expression: string) => expression.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''");

/**
 * What is safe to print however the thing is named: a class test (`x instanceof Y`) and the kind, code, status, id or size of something (`error.name`,
 * `result.status`, `row.id`, `list.length`): those are words and numbers of ours, not what the thing holds.
 */
const stripSafe = (expression: string) =>
  stripLiterals(expression)
    .replace(/[\w$.?]+\s+instanceof\s+[\w$.]+/g, "ok")
    // the class name of a thrown thing; `.name` of anything else (a contact, a profile) is a customer's name
    .replace(/\b(?:error|err|e|cause|failure|ex)\??\.name\b/g, "ok")
    .replace(/[\w$]+(?:\??\.[\w$]+)*\??\.(?:code|status|id|ids|length|size|count)\b/g, "ok")
    // identifiers that are ids (messageId, tenantId, connection_id) say nothing about what a message holds
    .replace(/(?:[\w$]+\??\.)*[\w$]*(?:Ids?|_ids?)\b/g, "ok")
    // names are looked at word by word: ownerPhone and wa_id are a phone and a wa id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_$]/g, " ");

/** Blanks the `// ...` comment at the end of each line, but not a `//` inside a string on that line ("a // b", a URL): quotes are tracked per line. */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
        } else if (c === "'" || c === '"' || c === "`") quote = c;
        else if (c === "/" && line[i + 1] === "/") return line.slice(0, i) + " ".repeat(line.length - i);
      }
      return line;
    })
    .join("\n");
}

/** Every log call in a source file. */
export function scanSource(file: string, src: string): LogCall[] {
  // Comments out, with the layout kept (so line numbers hold).
  const code = stripLineComments(src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")));
  const calls: LogCall[] = [];
  const re = /\bconsole\.(log|error|warn|info|debug)\s*\(/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const open = m.index + m[0].length;
    let depth = 1;
    let i = open;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === "'" || c === '"' || c === "`") {
        i = readLiteral(code, i).end;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    const inner = code.slice(open, i - 1);
    const flags: string[] = [];
    for (const arg of arguments_(inner)) {
      if (arg.literal) continue;
      const remainder = (arg as { remainder?: string }).remainder;
      if (remainder !== undefined && arg.expressions.length > 0) {
        // a conditional with strings in it: the code around the strings and each interpolation are looked at by name
        for (const piece of [remainder, ...arg.expressions]) {
          const hit = RISKY.exec(stripSafe(piece));
          if (hit) flags.push(`${piece.replace(/\s+/g, " ").slice(0, 80)} (${hit[0]})`);
        }
        continue;
      }
      if (arg.expressions.length === 0 && !arg.literal) {
        flags.push(`argument ${arg.text.replace(/\s+/g, " ").slice(0, 80)}`);
        continue;
      }
      for (const expression of arg.expressions) {
        const bare = stripSafe(expression);
        const hit = RISKY.exec(bare);
        if (hit) flags.push(`\${${expression.replace(/\s+/g, " ").slice(0, 80)}} (${hit[0]})`);
      }
    }
    calls.push({ file, line: code.slice(0, m.index).split("\n").length, method: m[1], text: code.slice(m.index, i).replace(/\s+/g, " "), flags });
  }
  return calls;
}

/** Every log call of the backend's own source. */
export function scanBackend(root = SRC_DIR): LogCall[] {
  const calls: LogCall[] = [];
  for (const path of sourceFiles(root)) {
    const rel = relative(root, path).split(sep).join("/");
    if (skipped(rel)) continue;
    calls.push(...scanSource(rel, readFileSync(path, "utf8")));
  }
  return calls;
}

/** The backend's own source files with their text (the same files scanBackend looks at). */
export function backendSources(root = SRC_DIR): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = [];
  for (const path of sourceFiles(root)) {
    const rel = relative(root, path).split(sep).join("/");
    if (!skipped(rel)) out.push({ file: rel, src: readFileSync(path, "utf8") });
  }
  return out;
}

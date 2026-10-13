// The route code in a visitor's message to the shared demo number: DEMO-<KEY> (a demo business) or
// TRIAL-<4 letters or digits> (a business's own trial, from the wa.me link the wizard shows). The text is
// customer input: only its first characters are read, and nothing here decides what a code is worth (the
// route_codes table does, demo/db.ts).

/** How much of a message is searched for a code. A code is at the start of what a person sends. */
export const CODE_SEARCH_CHARS = 200;
/** What an empty message becomes once its code is taken out, so the assistant has something to greet. */
export const GREETING = "Hi";

const CODE = /(?<![A-Z0-9-])(DEMO(?:-[A-Z0-9]{1,30}){1,3}|TRIAL-[A-Z0-9]{4})(?![A-Z0-9])/i;
// Phones and keyboards turn a hyphen into a longer dash. Each is one character, so a position in the changed text is a
// position in the original, which is otherwise left as the person wrote it.
const DASHES = /[‐-―−]/g;
const LEADING = /^[\s,.:;!\-–—]+/;
const TRAILING = /[\s,:;\-–—]+$/;

export type FoundCode = {
  /** Upper case, as stored in route_codes.code. */
  code: string;
  /** The message without the code, otherwise as the person wrote it; GREETING when nothing else was said. */
  rest: string;
};

export function findRouteCode(text: string): FoundCode | null {
  const match = CODE.exec(text.slice(0, CODE_SEARCH_CHARS).replace(DASHES, "-"));
  if (!match) return null;
  const before = text.slice(0, match.index).trimEnd();
  const after = text.slice(match.index + match[0].length).trimStart();
  const rest = [before, after].filter((part) => part !== "").join(" ").replace(LEADING, "").replace(TRAILING, "");
  return { code: match[1].toUpperCase(), rest: /[\p{L}\p{N}]/u.test(rest) ? rest : GREETING };
}

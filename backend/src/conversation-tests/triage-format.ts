// The pasted file of real chats the triage harness reads (docs: tests/triage/README.md). Plain text, UTF-8:
//
//   # name: Velachery enquiry        optional, names the chat that follows; any other line that is "#" or starts with "# " is a comment
//   anna Velachery la 2BHK price enna?   one customer message per line
//   site visit venum
//                                    a blank line starts a new chat
//   hello
//
// Indian mobile numbers are masked before anything is run or printed (real chats can hold them); everything else is kept exactly as pasted.

export const MAX_MESSAGES = 200;
export const MAX_LINE_CHARS = 1000;

export interface TriageChat {
  name: string;
  messages: string[];
}

// Any run of digits with spaces, dots, dashes or brackets between them that, once the separators and an optional +91, 91 or 0 are taken away, is a ten-digit Indian
// mobile number (starting 6 to 9). Prices, areas, years, pincodes, dates and times are not.
const CANDIDATE = /(?<!\d)[+(]*\d[\d\s().-]{8,18}\d(?!\d)/g;

export function maskPhones(text: string): string {
  return text.replace(CANDIDATE, (found) => {
    const digits = found.replace(/\D/g, "");
    const core = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
    return /^[6-9]\d{9}$/.test(core) ? "[phone]" : found;
  });
}

export function parseTriageFile(text: string, options: { keepNumbers?: boolean } = {}): { chats: TriageChat[] } {
  const chats: TriageChat[] = [];
  let current: string[] = [];
  let pendingName: string | null = null;
  let total = 0;

  const flush = () => {
    if (current.length > 0) {
      chats.push({ name: pendingName ?? `chat ${chats.length + 1}`, messages: current });
      pendingName = null;
    }
    current = [];
  };

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    // A comment is "#" alone or "#" and a space; "#2BHK price?" is a customer's message.
    if (line === "#" || line.startsWith("# ")) {
      const name = /^#\s*name:\s*(.+)$/i.exec(line);
      if (name && current.length === 0) pendingName = options.keepNumbers ? name[1].trim() : maskPhones(name[1].trim());
      continue;
    }
    if (line.length > MAX_LINE_CHARS) throw new Error(`Line ${index + 1} is ${line.length} characters long; the longest a message may be is ${MAX_LINE_CHARS}.`);
    if (++total > MAX_MESSAGES) throw new Error(`The file has more than ${MAX_MESSAGES} messages. Split it into smaller files.`);
    current.push(options.keepNumbers ? line : maskPhones(line));
  }
  flush();

  if (chats.length === 0) throw new Error("The file has no messages. Put one customer message per line, and a blank line between chats.");
  return { chats };
}

/** The fake knowledge base: one fact per non-blank line, `#` lines are comments. An empty file means no question has an answer. */
export function parseKbFile(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

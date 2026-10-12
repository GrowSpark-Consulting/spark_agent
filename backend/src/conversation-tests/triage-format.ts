// The pasted file of real chats the triage harness reads (docs: tests/triage/README.md). Plain text, UTF-8:
//
//   # name: Velachery enquiry        optional, names the chat that follows; any other line starting with # is a comment
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

// A ten-digit mobile number (starting 6 to 9), with or without +91 / 91, and with a space or dash in the middle. Prices, areas, years and times are not matched.
const PHONE = /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;

export const maskPhones = (text: string): string => text.replace(PHONE, "[phone]");

export function parseTriageFile(text: string, options: { keepNumbers?: boolean } = {}): { chats: TriageChat[] } {
  const chats: TriageChat[] = [];
  let current: string[] = [];
  let pendingName: string | null = null;
  let total = 0;

  const flush = () => {
    if (current.length > 0) chats.push({ name: pendingName ?? `chat ${chats.length + 1}`, messages: current });
    if (current.length > 0) pendingName = null;
    current = [];
  };

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("#")) {
      const name = /^#\s*name:\s*(.+)$/i.exec(line);
      if (name && current.length === 0) pendingName = name[1].trim();
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

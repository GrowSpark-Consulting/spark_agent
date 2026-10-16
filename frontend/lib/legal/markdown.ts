// A small reader for the policy files in content/legal/*.md. It handles only what those files use: "#" and "##"
// headings, paragraphs (a line ending in two spaces is a line break), "- " lists, **bold**, `code` and [text](url).
// The output is a plain tree that components/legal renders as React elements, so the policy text is shown as written.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "br" };

export type Block =
  | { kind: "h1" | "h2"; children: Inline[] }
  | { kind: "p"; children: Inline[] }
  | { kind: "ul"; items: Inline[][] };

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of source.matchAll(INLINE)) {
    if (m.index > last) out.push({ kind: "text", text: source.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "bold", children: parseInline(m[1]) });
    else if (m[2] !== undefined) out.push({ kind: "code", text: m[2] });
    else out.push({ kind: "link", text: m[3]!, href: m[4]! });
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push({ kind: "text", text: source.slice(last) });
  return out;
}

// Lines of one paragraph joined with a space, except after a line that ends in two spaces, which becomes a break.
function paragraph(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, i) => {
    const hardBreak = / {2,}$/.test(line) && i < lines.length - 1;
    out.push(...parseInline(line.trim()));
    if (hardBreak) out.push({ kind: "br" });
    else if (i < lines.length - 1) out.push({ kind: "text", text: " " });
  });
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let lines: string[] = [];
  let items: Inline[][] = [];

  const flush = () => {
    if (lines.length) blocks.push({ kind: "p", children: paragraph(lines) });
    if (items.length) blocks.push({ kind: "ul", items });
    lines = [];
    items = [];
  };

  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim() === "") flush();
    else if (line.startsWith("# ") || line.startsWith("## ")) {
      flush();
      const level = line.startsWith("# ") ? "h1" : "h2";
      blocks.push({ kind: level, children: parseInline(line.slice(level === "h1" ? 2 : 3).trim()) });
    } else if (line.startsWith("- ")) {
      if (lines.length) flush();
      items.push(parseInline(line.slice(2).trim()));
    } else {
      if (items.length) flush();
      lines.push(line);
    }
  }
  flush();
  return blocks;
}

export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.kind === "text" || n.kind === "code" || n.kind === "link" ? n.text : n.kind === "bold" ? inlineText(n.children) : " "))
    .join("");
}

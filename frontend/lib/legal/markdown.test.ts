import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LEGAL_SLUGS } from "./documents";
import { inlineText, parseMarkdown, type Block } from "./markdown";

const words = (s: string) => s.replace(/\s+/g, " ").trim();

function blockText(b: Block): string {
  return b.kind === "ul" ? b.items.map(inlineText).join(" ") : inlineText(b.children);
}

describe("parseMarkdown", () => {
  it("reads headings, paragraphs with hard breaks, lists, bold, code and links", () => {
    const blocks = parseMarkdown("# Title\n\n**A:** b  \nc `x` [t](https://e.com/p)\n\n## Head\n\n- one\n- two\n");
    expect(blocks.map((b) => b.kind)).toEqual(["h1", "p", "h2", "ul"]);
    expect(blocks[1]).toEqual({
      kind: "p",
      children: [
        { kind: "bold", children: [{ kind: "text", text: "A:" }] },
        { kind: "text", text: " b" },
        { kind: "br" },
        { kind: "text", text: "c " },
        { kind: "code", text: "x" },
        { kind: "text", text: " " },
        { kind: "link", text: "t", href: "https://e.com/p" },
      ],
    });
    expect(blocks[3]).toEqual({ kind: "ul", items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]] });
  });

  it("starts a new paragraph when a list ends without a blank line", () => {
    expect(parseMarkdown("- a\nnext").map((b) => b.kind)).toEqual(["ul", "p"]);
  });
});

describe("policy files", () => {
  // The pages must show the policy wording as written: only markdown markup may be dropped.
  it.each(LEGAL_SLUGS)("%s keeps every word of its source", (slug) => {
    const source = readFileSync(path.join(process.cwd(), "content", "legal", `${slug}.md`), "utf8");
    const expected = source
      .replace(/^#{1,2} /gm, "")
      .replace(/^- /gm, "")
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    expect(words(parseMarkdown(source).map(blockText).join(" "))).toBe(words(expected));
  });
});

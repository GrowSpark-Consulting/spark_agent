import { readFile } from "node:fs/promises";
import path from "node:path";
import { inlineText, parseMarkdown, type Block } from "./markdown";

// The three policy pages Meta links to. The text lives in content/legal/<slug>.md and is shown exactly as written.
export const LEGAL_SLUGS = ["privacy", "terms", "data-deletion"] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

export type LegalDocument = { slug: LegalSlug; title: string; effectiveDate: string; blocks: Block[] };

export async function loadLegalDocument(slug: LegalSlug): Promise<LegalDocument> {
  const source = await readFile(path.join(process.cwd(), "content", "legal", `${slug}.md`), "utf8");
  const blocks = parseMarkdown(source);
  const heading = blocks.find((b) => b.kind === "h1");
  const effectiveDate = /^\*\*Effective date:\*\*\s*(.+?)\s*$/m.exec(source)?.[1];
  if (!heading || !effectiveDate) throw new Error(`content/legal/${slug}.md needs a "# " title and an "**Effective date:**" line`);
  return { slug, title: inlineText("children" in heading ? heading.children : []), effectiveDate, blocks };
}

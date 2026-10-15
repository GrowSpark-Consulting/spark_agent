import { Parser } from "htmlparser2";
import { stripUnsafeCharacters } from "../lib/text";

// The readable text of a web page, for the knowledge base (kb/website.ts). htmlparser2 only tokenizes: nothing in the page is run, fetched or followed,
// and the parser is iterative (a page nested 50,000 deep cannot overflow the stack). What is kept is the page's words, one block to a line; what is dropped
// is what is not the page's own content: scripts, styles, menus, footers, sidebars, forms, hidden parts, dialogs and cookie banners. When the page has a
// <main> or an <article> with enough text, only that is used. The title is the <title>, else the og:title, else the first <h1>.

/** A <main> or <article> with less text than this is not taken to be the page's content. */
export const MAIN_MIN_CHARS = 200;
export const TITLE_MAX_CHARS = 200;
/**
 * htmlparser2 slows down sharply (about with the square of the depth) on a page nested very deeply: 50,000 levels take seconds, and 2 MB of unclosed tags would block the
 * API for minutes. A real page is nested dozens of levels deep, so a page nested deeper than this, or with more elements than this, is refused as unreadable BEFORE the parser
 * is let near it, by stopping it from inside its own callbacks.
 */
export const MAX_DEPTH = 512;
export const MAX_ELEMENTS = 100_000;

/** The page's markup is too deep or too big to read safely. */
export class PageTooComplexError extends Error {
  constructor() {
    super("the page is too complex to read");
    this.name = "PageTooComplexError";
  }
}

/** Whole parts that are never the page's words. */
const DROPPED_TAGS = new Set(["head", "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "nav", "footer", "aside", "form", "button", "select", "textarea", "dialog"]);
/** Elements that start a new line, before and after. */
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "table", "tr", "blockquote", "pre", "figure", "figcaption",
  "address", "details", "summary", "fieldset", "legend", "header", "hgroup", "caption", "thead", "tbody", "tfoot",
]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const DROPPED_ROLES = new Set(["navigation", "contentinfo", "dialog", "alertdialog", "complementary", "search"]);
/** A class or id that names a cookie or consent banner. Linear: no nested repetition. */
const COOKIE_BANNER = /cookie|consent|gdpr|onetrust|cookielaw|cc-window|cc-banner/i;
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;
const ATTRIBUTE_LOOKED_AT_MAX = 1000;

interface Open {
  name: string;
  /** This element starts a part that is dropped. */
  drops: boolean;
  /** This element is a <main> or <article>. */
  main: boolean;
}

const tidyLine = (text: string) => text.replace(/\s+/g, " ").trim();
const cut = (text: string, max: number) => [...text].slice(0, max).join("").trim();

function hiddenOrBanner(attribs: Record<string, string>): boolean {
  if (attribs.hidden !== undefined || attribs["aria-hidden"]?.trim().toLowerCase() === "true") return true;
  const style = attribs.style?.slice(0, ATTRIBUTE_LOOKED_AT_MAX);
  if (style && HIDDEN_STYLE.test(style)) return true;
  const role = attribs.role?.trim().toLowerCase();
  if (role && DROPPED_ROLES.has(role)) return true;
  return COOKIE_BANNER.test(`${attribs.class ?? ""} ${attribs.id ?? ""}`.slice(0, ATTRIBUTE_LOOKED_AT_MAX));
}

/** Lines of the collected text: spaces collapsed, cell bars tidied, empty lines gone. */
function lines(parts: string[]): string {
  return parts
    .join("")
    .split("\n")
    .map((line) => tidyLine(line).replace(/^\|\s*/, "").replace(/\s*\|$/, ""))
    .filter((line) => line.length > 0)
    .join("\n");
}

export function htmlToText(html: string): { title: string | null; text: string } {
  const stack: Open[] = [];
  let skipping = 0;
  let inMain = 0;
  const all: string[] = [];
  const main: string[] = [];
  const put = (value: string) => {
    if (skipping > 0) return;
    all.push(value);
    if (inMain > 0) main.push(value);
  };

  let inTitle = false;
  let titleText = "";
  let ogTitle = "";
  let inH1 = 0;
  let h1Text = "";
  let h1Done = false;
  let elements = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (++elements > MAX_ELEMENTS) throw new PageTooComplexError();
        // The <meta> and <title> are in the head, which is dropped: they are read before anything is skipped.
        if (name === "meta" && ogTitle === "" && attribs.property?.toLowerCase() === "og:title") ogTitle = tidyLine(stripUnsafeCharacters(attribs.content ?? ""));
        if (name === "title" && titleText === "") inTitle = true;
        if (VOID_TAGS.has(name)) {
          if (name === "br" || name === "hr") put("\n");
          return;
        }
        const drops = DROPPED_TAGS.has(name) || (name === "header" && inMain === 0) || hiddenOrBanner(attribs);
        const isMain = name === "main" || name === "article";
        stack.push({ name, drops, main: isMain });
        if (stack.length > MAX_DEPTH) throw new PageTooComplexError();
        if (drops) skipping++;
        if (isMain) inMain++;
        if (name === "h1" && skipping === 0 && !h1Done) inH1++;
        if (BLOCK_TAGS.has(name)) put("\n");
      },
      ontext(data) {
        const clean = stripUnsafeCharacters(data);
        if (inTitle) titleText += clean;
        if (skipping > 0) return;
        const text = clean.replace(/\s+/g, " ");
        if (inH1 > 0) h1Text += text;
        put(text);
      },
      onclosetag(name) {
        if (VOID_TAGS.has(name)) return;
        if (name === "title") inTitle = false;
        let index = stack.length - 1;
        while (index >= 0 && stack[index].name !== name) index--;
        if (index < 0) return; // a closing tag with nothing open
        while (stack.length > index) {
          const open = stack.pop() as Open;
          if (open.drops) skipping--;
          if (open.main) inMain--;
          if (open.name === "h1" && inH1 > 0) {
            inH1--;
            if (inH1 === 0 && !h1Done && tidyLine(h1Text) !== "") h1Done = true;
            else if (inH1 === 0) h1Text = "";
          }
          if (open.name === "td" || open.name === "th") put(" | ");
          if (BLOCK_TAGS.has(open.name)) put("\n");
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  const mainText = lines(main);
  const text = mainText.length >= MAIN_MIN_CHARS ? mainText : lines(all);
  const title = [tidyLine(titleText), ogTitle, tidyLine(h1Text)].find((candidate) => candidate !== "") ?? null;
  return { title: title === null ? null : cut(title, TITLE_MAX_CHARS), text };
}

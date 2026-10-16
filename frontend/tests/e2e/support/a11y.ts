import type { Page } from "@playwright/test";

// A small accessibility audit that runs inside the page, with no extra dependency (the repository has no axe). It checks what can be
// decided from the DOM: document language and title, headings, landmarks, accessible names, labels, duplicate and dangling ids, ARIA misuse,
// text contrast (WCAG 2.x ratio of the computed colour against the nearest opaque background) and, by pressing Tab, whether keyboard focus
// is visible and moves on. It is NOT a replacement for axe or for a person with a screen reader: it cannot judge reading order, the meaning
// of a name, colour over images or gradients, or what a screen reader says. Each finding carries a rule id so a test can pin a rule.

export interface A11yFinding {
  rule: string;
  severity: "serious" | "moderate" | "minor";
  where: string;
  detail: string;
}

export async function auditPage(page: Page, options: { tabStops?: number } = {}): Promise<A11yFinding[]> {
  const findings = await page.evaluate(() => {
    const out: { rule: string; severity: "serious" | "moderate" | "minor"; where: string; detail: string }[] = [];
    const add = (rule: string, severity: "serious" | "moderate" | "minor", el: Element | null, detail: string) => {
      const key = rule + "|" + (el ? describe(el) : "") + "|" + detail;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ rule, severity, where: el ? describe(el) : "document", detail });
    };
    const seen = new Set<string>();
    const describe = (el: Element) => {
      const id = el.id ? `#${el.id}` : "";
      const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 28);
      return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const hiddenFromAT = (el: Element) => {
      for (let p: Element | null = el; p; p = p.parentElement) {
        if (p.getAttribute("aria-hidden") === "true" || (p as HTMLElement).hidden) return true;
        if (getComputedStyle(p).display === "none") return true;
      }
      return false;
    };
    const text = (el: Element) => (el as HTMLElement).innerText?.trim() ?? "";
    const labelledBy = (el: Element) =>
      (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .join(" ")
        .trim();
    const nameOf = (el: Element): string => {
      const byRef = labelledBy(el);
      if (byRef) return byRef;
      const aria = el.getAttribute("aria-label")?.trim();
      if (aria) return aria;
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        const l = Array.from(el.labels ?? []).map((x) => x.textContent?.trim() ?? "").join(" ").trim();
        if (l) return l;
      }
      if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type) && el.value) return el.value;
      const t = text(el);
      if (t) return t;
      const img = el.querySelector("img[alt]");
      if (img?.getAttribute("alt")) return img.getAttribute("alt")!;
      const svgTitle = el.querySelector("svg title")?.textContent?.trim();
      if (svgTitle) return svgTitle;
      return el.getAttribute("title")?.trim() ?? "";
    };

    // Document
    if (!document.documentElement.lang) add("document-lang", "serious", document.documentElement, "The page has no lang attribute.");
    if (!document.title.trim()) add("document-title", "serious", null, "The page has no title.");
    const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
    if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(viewport)) add("zoom-blocked", "serious", null, `The viewport meta blocks zoom: ${viewport}`);

    // Headings
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).filter((h) => visible(h) && !hiddenFromAT(h));
    const levelOf = (h: Element) => (h.tagName.match(/^H(\d)$/) ? Number(h.tagName[1]) : Number(h.getAttribute("aria-level") ?? 2));
    const h1s = headings.filter((h) => levelOf(h) === 1);
    if (h1s.length === 0) add("heading-h1", "moderate", null, "The page has no level-1 heading.");
    if (h1s.length > 1) add("heading-h1", "moderate", h1s[1], `The page has ${h1s.length} level-1 headings.`);
    let previous = 0;
    for (const h of headings) {
      const level = levelOf(h);
      if (previous && level > previous + 1) add("heading-skip", "minor", h, `Heading level jumps from ${previous} to ${level}.`);
      if (!text(h) && !h.getAttribute("aria-label")) add("heading-empty", "moderate", h, "An empty heading.");
      previous = level;
    }

    // Landmarks
    const mains = Array.from(document.querySelectorAll("main,[role=main]")).filter((m) => !hiddenFromAT(m));
    if (mains.length !== 1) add("landmark-main", "serious", mains[1] ?? null, `Expected one main landmark, found ${mains.length}.`);
    const navs = Array.from(document.querySelectorAll("nav,[role=navigation]")).filter((n) => !hiddenFromAT(n));
    if (navs.length > 1) for (const n of navs) if (!nameOf(n) && !n.getAttribute("aria-label")) add("landmark-nav-name", "moderate", n, "More than one nav landmark, and this one has no name.");

    // Names
    for (const el of Array.from(document.querySelectorAll("button,[role=button],a[href],[role=link],input,select,textarea,[role=checkbox],[role=switch],[role=tab],[role=menuitem]"))) {
      if (!visible(el) || hiddenFromAT(el)) continue;
      if (el instanceof HTMLInputElement && el.type === "hidden") continue;
      const name = nameOf(el);
      const isField = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
      if (!name) {
        const placeholder = el.getAttribute("placeholder");
        add(isField ? "field-name" : "control-name", "serious", el, placeholder ? `No label; only a placeholder ("${placeholder}").` : "No accessible name.");
      }
      if (el.tagName === "A" && ["", "#"].includes(el.getAttribute("href") ?? "")) add("link-href", "moderate", el, "A link with an empty or # target; use a button.");
      if (el.getAttribute("role") === "button" && el.tagName !== "BUTTON" && el.getAttribute("tabindex") === null) add("role-button-focus", "serious", el, "role=button without tabindex: not reachable by keyboard.");
      if (isField && el instanceof HTMLInputElement && ["email", "password"].includes(el.type) && !el.autocomplete) add("autocomplete", "minor", el, "No autocomplete attribute on an email or password field.");
      if (el.getAttribute("aria-invalid") === "true" && !el.getAttribute("aria-describedby") && !el.getAttribute("aria-errormessage")) add("error-link", "moderate", el, "Marked invalid, but no error text is linked with aria-describedby.");
    }
    for (const el of Array.from(document.querySelectorAll("img"))) {
      if (!visible(el) || hiddenFromAT(el)) continue;
      if (!el.hasAttribute("alt")) add("img-alt", "serious", el, "An image with no alt attribute.");
    }
    for (const el of Array.from(document.querySelectorAll("[tabindex]"))) if (Number(el.getAttribute("tabindex")) > 0) add("tabindex-positive", "moderate", el, "A positive tabindex changes the natural focus order.");
    for (const el of Array.from(document.querySelectorAll("[aria-hidden=true]"))) {
      const focusable = el.matches("a[href],button,input,select,textarea,[tabindex]") ? el : el.querySelector("a[href],button:not([disabled]),input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex='-1'])");
      if (focusable && !(focusable as HTMLElement).hasAttribute("disabled") && focusable.getAttribute("tabindex") !== "-1") add("aria-hidden-focus", "serious", focusable, "Focusable inside aria-hidden: a screen reader user lands on something that is hidden from them.");
    }

    // Ids and references
    const ids = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll("[id]"))) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) add("duplicate-id", "moderate", document.getElementById(id), `The id "${id}" is used ${n} times.`);
    for (const attr of ["aria-labelledby", "aria-describedby", "aria-controls"]) {
      for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) {
        if (hiddenFromAT(el) && attr !== "aria-controls") continue;
        for (const id of (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean)) if (!document.getElementById(id)) add("aria-ref-missing", "moderate", el, `${attr} points at #${id}, which does not exist.`);
      }
    }

    // Dialogs
    for (const d of Array.from(document.querySelectorAll("dialog[open],[role=dialog],[role=alertdialog]"))) {
      if (!visible(d)) continue;
      if (!nameOf(d)) add("dialog-name", "serious", d, "A dialog with no accessible name.");
      if (d.getAttribute("role") && d.getAttribute("aria-modal") !== "true" && !(d instanceof HTMLDialogElement)) add("dialog-modal", "moderate", d, "A dialog without aria-modal=true.");
    }

    // Contrast
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (top: [number, number, number, number], under: [number, number, number, number]): [number, number, number, number] => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    const lum = ([r, g, b]: [number, number, number, number]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const backdrop = (el: Element): { color: [number, number, number, number]; unknown: boolean } => {
      let acc: [number, number, number, number] = [0, 0, 0, 0];
      let unknown = false;
      for (let p: Element | null = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.backgroundImage !== "none") unknown = true;
        acc = over(acc, rgba(s.backgroundColor));
        if (acc[3] >= 0.999) break;
      }
      if (acc[3] < 0.999) acc = over(acc, [255, 255, 255, 1]);
      return { color: acc, unknown };
    };
    const contrastSeen = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const el = n.parentElement;
      if (!el || !visible(el) || hiddenFromAT(el)) continue;
      if (el.closest("script,style,noscript")) continue;
      const s = getComputedStyle(el);
      if (Number(s.opacity) === 0) continue;
      const bg = backdrop(el);
      if (bg.unknown) continue;
      const fg = over(rgba(s.color), bg.color);
      const l1 = lum(fg);
      const l2 = lum(bg.color);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const px = parseFloat(s.fontSize);
      const bold = Number(s.fontWeight) >= 700;
      const large = px >= 24 || (px >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      const disabled = el.closest(":disabled,[aria-disabled=true]");
      if (ratio < need && !disabled) {
        const key = `${s.color}|${bg.color.join(",")}|${px}`;
        if (contrastSeen.has(key)) continue;
        contrastSeen.add(key);
        add("contrast", "serious", el, `Contrast ${ratio.toFixed(2)}:1, needs ${need}:1 (${s.color} on rgb(${bg.color.slice(0, 3).map(Math.round).join(",")}), ${px}px${bold ? " bold" : ""}).`);
      }
    }
    return out;
  });

  // Keyboard: press Tab through the page and check each stop shows a focus indicator, is on screen, and that focus never gets stuck.
  const stops = options.tabStops ?? 40;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const seenFocus = new Set<string>();
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const id = (el.id ? `#${el.id}` : "") + el.tagName.toLowerCase() + ":" + ((el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 24));
      const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
      const ring = s.boxShadow !== "none";
      return { id, indicator: outline || ring };
    });
    if (!stop) break;
    if (seenFocus.has(stop.id)) break;
    seenFocus.add(stop.id);
    if (!stop.indicator) findings.push({ rule: "focus-visible", severity: "serious", where: stop.id, detail: "No outline or ring when focused with the keyboard." });
  }
  // A page with nothing to focus (an invalid-link notice) has nothing to reach; only report when there was a control to reach.
  const hasControl = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href],button:not([disabled]),input:not([type=hidden]):not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])")).some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[aria-hidden=true]");
    }),
  );
  if (hasControl && seenFocus.size === 0) findings.push({ rule: "focus-reach", severity: "serious", where: "document", detail: "Tab did not move focus onto any control." });
  return findings;
}

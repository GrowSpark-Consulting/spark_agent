import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RefreshControl } from "./refresh-control";

// The Refresh button and its one line. The line says "live" only when the database is really sending changes for the
// screen's tables, so a screen whose tables are not published can never claim it. Static markup: words and attributes.

const render = (props: Partial<ComponentProps<typeof RefreshControl>> = {}) =>
  renderToStaticMarkup(createElement(RefreshControl, { live: "unavailable", refreshing: false, failed: false, onRefresh: () => {}, ...props }));
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();

describe("RefreshControl", () => {
  it("says nothing updates by itself when the tables aren't published, and offers Refresh", () => {
    const html = render({ live: "unavailable" });
    expect(words(html)).toBe("Refresh Not updating live. Use Refresh.");
    expect(html).not.toContain("disabled");
  });

  it("says live only when live", () => {
    expect(words(render({ live: "live" }))).toBe("Refresh Updating live.");
    expect(words(render({ live: "connecting" }))).toBe("Refresh");
    expect(words(render({ live: "unavailable" }))).not.toMatch(/Updating live/);
  });

  it("disables the button and says so while a read runs", () => {
    const html = render({ refreshing: true });
    expect(words(html)).toContain("Refreshing…");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
  });

  it("says a failed refresh left the last read on screen, whatever the live state", () => {
    expect(words(render({ failed: true, live: "live" }))).toContain("Couldn’t refresh. You’re seeing the last read.");
    expect(words(render({ failed: true, live: "live" }))).not.toContain("Updating live");
  });

  it("announces its line politely, so a change is heard without taking focus", () => {
    expect(render()).toMatch(/role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="status"/);
  });
});

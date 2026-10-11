import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agendaMessage } from "../booking/daily-agenda";
import { noShowMessage } from "../booking/no-show";
import { ratingMessage, reviewMessage } from "../booking/post-visit";
import { reminderMessage, type ReminderBooking } from "../booking/reminders";
import { nudgeMessage } from "../leads/nudges";
import { KINDS } from "./kinds";
import { TEMPLATE_CATALOGUE, templateComponents, variablesIn, type TemplateLanguage } from "./template-catalogue";

const LANGUAGES: TemplateLanguage[] = ["en", "ta"];
const byName = new Map(TEMPLATE_CATALOGUE.map((t) => [t.name, t]));
const byBase = new Map(TEMPLATE_CATALOGUE.map((t) => [t.base, t]));
const packsDir = join(fileURLToPath(new URL(".", import.meta.url)), "../../../packs");

describe("the template catalogue", () => {
  it("names every template <base>_vN, once", () => {
    for (const t of TEMPLATE_CATALOGUE) expect(t.name).toBe(`${t.base}_v${t.name.split("_v").pop()}`);
    for (const t of TEMPLATE_CATALOGUE) expect(t.name).toMatch(/^[a-z0-9_]+_v\d+$/);
    expect(byName.size).toBe(TEMPLATE_CATALOGUE.length);
  });

  it("has every template a pack lists and every template a message kind sends", () => {
    for (const file of readdirSync(packsDir).filter((f) => f.endsWith(".json"))) {
      const pack = JSON.parse(readFileSync(join(packsDir, file), "utf8")) as { templates?: string[] };
      for (const name of pack.templates ?? []) expect(byName.has(name), `${file}: ${name}`).toBe(true);
    }
    for (const [kind, config] of Object.entries(KINDS)) {
      if (config.template) expect(byBase.has(config.template), `${kind}: ${config.template}`).toBe(true);
    }
  });

  it.each(TEMPLATE_CATALOGUE.map((t) => [t.name, t] as const))("%s keeps to Meta's rules in English and Tamil", (_name, t) => {
    expect(t.examples).toHaveLength(t.variables.length);
    for (const language of LANGUAGES) {
      const text = t.text[language];
      // Exactly {{1}}…{{n}}, one per variable.
      expect(variablesIn(text.body)).toEqual(t.variables.map((_, i) => i + 1));
      // A variable may not start or end the body: words come before the first and after the last.
      expect(text.body.trim()).not.toMatch(/^\{\{\d+\}\}/);
      expect(text.body.slice(text.body.lastIndexOf("}}") + 2)).toMatch(/\p{L}/u);
      expect(text.body.length).toBeLessThanOrEqual(1024);
      if (text.footer) expect(text.footer.length).toBeLessThanOrEqual(60);
      expect((text.quickReplies ?? []).length).toBeLessThanOrEqual(10);
      for (const reply of text.quickReplies ?? []) expect([...reply].length).toBeLessThanOrEqual(25);
      // The same buttons in every language, so a tap means the same thing.
      expect((text.quickReplies ?? []).length).toBe((t.text.en.quickReplies ?? []).length);
    }
    if (t.category === "marketing") for (const language of LANGUAGES) expect(t.text[language].footer).toBeTruthy();
  });

  it("asks for exactly the variables the jobs send", () => {
    const booking: ReminderBooking = {
      bookingId: "9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b",
      status: "confirmed",
      start: "2026-10-10T11:30:00.000Z",
      end: "2026-10-10T12:30:00.000Z",
      leadId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
      staffUserId: null,
      what: "site visit",
      business: "Skyline Homes",
      timeZone: "Asia/Kolkata",
      conversationId: null,
    };
    const sent: Record<string, number> = {
      reminder_24h: reminderMessage(booking).templateParams.length,
      reminder_2h: reminderMessage(booking).templateParams.length,
      feedback: ratingMessage(booking).templateParams.length,
      review: reviewMessage("Skyline Homes", "https://g.page/r/x").templateParams.length,
      nudge: nudgeMessage(1, "Priya").templateParams.length,
      noshow_rebook: noShowMessage(booking).templateParams.length,
      daily_agenda: agendaMessage("Skyline Homes", [{ time: "11:00 am", what: "site visit", who: "Priya", staff: null }], "https://app.example").templateParams.length,
      // staff-alerts.ts and the own-number outcome job send [headline, link].
      staff_alert: 2,
      // The pipeline's booking confirmation sends what, business and when, like the reminders.
      booking_confirmed: 3,
    };
    for (const t of TEMPLATE_CATALOGUE) expect(t.variables.length, t.name).toBe(sent[t.base]);
  });

  it("builds Meta's components for submission", () => {
    expect(templateComponents(byName.get("reminder_24h_v1")!, "en")).toEqual([
      {
        type: "BODY",
        text: "Reminder: your {{1}} with {{2}} is on {{3}}. Tap a button below to confirm or change it.",
        example: { body_text: [["site visit", "Skyline Homes", "Sat 10 Oct, 5:00 pm"]] },
      },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirm" }, { type: "QUICK_REPLY", text: "Reschedule" }, { type: "QUICK_REPLY", text: "Cancel" }] },
    ]);
    expect(templateComponents(byName.get("review_v1")!, "ta")).toContainEqual({ type: "FOOTER", text: "இந்த செய்திகளை நிறுத்த STOP என பதில் அனுப்பவும்" });
  });
});

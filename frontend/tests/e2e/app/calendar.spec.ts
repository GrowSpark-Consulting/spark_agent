import type { Page } from "@playwright/test";
import { appAlert, expect, expectNoHorizontalOverflow, mainNav, SIGNED_OUT, test } from "../support/app";
import { DAY, newDay3Account, open, writesBy, type Day3Account } from "../support/day3";

// /dashboard/calendar (Day 3, read-only): day and week views, staff and resource filter, bookings at
// their time in the business's zone (Asia/Kolkata) with their length and status. Bookings and resources
// come from mock-supabase.mjs under RLS (mocked E2E); see support/day3.ts for the seeded week.

/** An accessible name from its words; \s also matches the narrow space some ICU builds put before "am". */
const named = (...words: string[]) => new RegExp(`^${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join(",\\s+")}$`);
const booking = (page: Page, customer: string, time: string, status: string) => page.getByRole("button", { name: named(customer, time, status) });
const panel = (page: Page) => page.getByRole("complementary", { name: "Booking details" });
const staffChip = (page: Page, name: string) => page.getByRole("group", { name: "Staff and resources" }).getByRole("button", { name, exact: true });
const narrow = (page: Page) => page.viewportSize()!.width < 720;

async function openDay(page: Page, account: Day3Account, query = `date=${DAY}`) {
  await open(page, account, `/dashboard/calendar?${query}`, /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d+ \w+$|^Week of/);
}

test.describe("Calendar", () => {
  test.use({ storageState: SIGNED_OUT });

  test("day view: a column per staff member, bookings at their local time, no one-assigned callbacks apart", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDay(page, account);
    await expect(mainNav(page).getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Monday 12 Oct");
    await expect(page.getByText(/^3 bookings (today|this day) · 1 held, waiting for the customer · Times in Asia\/Kolkata$/)).toBeVisible();

    await expect(booking(page, "Karthik R", "10:00 am – 11:00 am", "Confirmed")).toBeVisible();
    await expect(booking(page, "Priya S", "11:30 am – 12:00 pm", "Held")).toBeVisible();
    // A callback with no staff member: its own lane, never in someone's column.
    await expect(booking(page, "+91 90xxx xxx52", "4:00 pm – 4:15 pm", "Confirmed")).toBeVisible();
    // A hold that lapsed and a cancelled booking aren't appointments.
    await expect(page.getByRole("button", { name: /Lakshmi V/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Deepa N/ })).toHaveCount(0);

    if (!narrow(page)) {
      await expect(page.getByTestId(`column-${account.ids.asha}`).getByRole("button")).toHaveAccessibleName(named("Karthik R", "10:00 am – 11:00 am", "Confirmed"));
      await expect(page.getByTestId(`column-${account.ids.ravi}`).getByRole("button")).toHaveAccessibleName(named("Priya S", "11:30 am – 12:00 pm", "Held"));
      await expect(page.getByTestId("column-none").getByRole("button")).toHaveCount(1);
      // A switched-off resource with nothing booked today gets no column.
      await expect(page.getByTestId(`column-${account.ids.room}`)).toHaveCount(0);
      // Length: a 60-minute block is twice the hour grid's half hour, plus the 30-minute one's floor.
      const hour = (await booking(page, "Karthik R", "10:00 am – 11:00 am", "Confirmed").boundingBox())!;
      const half = (await booking(page, "Priya S", "11:30 am – 12:00 pm", "Held").boundingBox())!;
      expect(hour.height).toBeGreaterThan(half.height * 1.8);
      // 10:00 starts above 11:30 by an hour and a half of grid.
      expect(half.y - hour.y).toBeCloseTo((hour.height + 4) * 1.5, -1);
    } else {
      // Phones: an agenda list in time order.
      await expect(page.getByTestId("agenda-item")).toHaveCount(3);
      await expect(page.getByTestId("agenda-item").first()).toHaveAccessibleName(named("Karthik R", "10:00 am – 11:00 am", "Confirmed"));
    }
    await expectNoHorizontalOverflow(page);
  });

  test("booking details open the lead and the browser writes no table", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDay(page, account);
    await booking(page, "Karthik R", "10:00 am – 11:00 am", "Confirmed").click();
    const details = panel(page);
    await expect(details).toBeVisible();
    await expect(details.getByRole("definition")).toHaveText(["Mon 12 Oct, 10:00 am – 11:00 am", "1 h", "Consultation", "Asha", "Appointment"]);
    await expect(details).toContainText("+91 98xxx xxx21");
    await expect(details.getByRole("link", { name: "Open lead" })).toHaveAttribute("href", `/dashboard/leads/${account.ids.karthik}`);
    // Changes go through the API (calendar-actions.spec.ts), never as table writes from the browser.
    await expect(details.getByRole("button", { name: "Move to another time" })).toBeVisible();

    await details.getByRole("button", { name: "Close" }).click();
    await expect(panel(page)).toHaveCount(0);
    await booking(page, "Priya S", "11:30 am – 12:00 pm", "Held").click();
    await expect(panel(page)).toContainText("Not confirmed yet");
    await expect(panel(page)).toContainText("Held until");
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);

    // The calendar reads under RLS and never writes a table itself.
    expect(await writesBy(request, account.email)).toEqual([]);
  });

  test.describe("viewed from another time zone", () => {
    test.use({ timezoneId: "America/New_York", locale: "en-US" });

    test("shows times in the business's zone, not the viewer's", async ({ page, request }) => {
      const account = await newDay3Account(request, { seed: true });
      await openDay(page, account);
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("America/New_York");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Monday 12 Oct");
      await expect(booking(page, "Karthik R", "10:00 am – 11:00 am", "Confirmed")).toBeVisible();
      await expect(page.getByText(/Times in Asia\/Kolkata/)).toBeVisible();
    });
  });

  test("shows cancelled, moved and expired bookings when asked, struck through", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDay(page, account);
    await page.getByLabel("Show cancelled, moved and expired").check();
    await expect(booking(page, "Lakshmi V", "2:00 pm – 3:00 pm", "Hold expired")).toBeVisible();
    await expect(booking(page, "Deepa N", "12:00 pm – 1:00 pm", "Cancelled")).toBeVisible();
    await booking(page, "Deepa N", "12:00 pm – 1:00 pm", "Cancelled").click();
    await expect(panel(page)).toContainText("The customer picked another time");
  });

  test("filters by staff member, and by bookings with no one assigned", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDay(page, account);
    await expect(staffChip(page, "All staff")).toHaveAttribute("aria-pressed", "true");
    // Switched-off resources with no bookings in view aren't offered.
    await expect(staffChip(page, "Room 2")).toHaveCount(0);

    await staffChip(page, "Ravi").click();
    await expect(staffChip(page, "Ravi")).toHaveAttribute("aria-pressed", "true");
    await expect(booking(page, "Priya S", "11:30 am – 12:00 pm", "Held")).toBeVisible();
    await expect(page.getByRole("button", { name: /Karthik R/ })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`resource=${account.ids.ravi}`));

    await staffChip(page, "No staff assigned").click();
    await expect(booking(page, "+91 90xxx xxx52", "4:00 pm – 4:15 pm", "Confirmed")).toBeVisible();
    await expect(page.getByRole("button", { name: /Priya S|Karthik R/ })).toHaveCount(0);
    await expect(page.getByText(/^1 booking (today|this day) · Times in Asia\/Kolkata$/)).toBeVisible();
  });

  test("week view: Monday to Sunday, each booking on its day", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDay(page, account);
    await page.getByRole("button", { name: "Week", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Week of Mon 12 Oct");
    await expect(page).toHaveURL(/view=week/);
    await expect(page.getByText(/^5 bookings this week · 1 held/)).toBeVisible();
    await expect(booking(page, "Karthik R", "3:00 pm – 4:00 pm", "Confirmed")).toBeVisible();
    await expect(booking(page, "Lakshmi V", "10:00 am – 11:00 am", "Completed")).toBeVisible();
    if (!narrow(page)) {
      for (const [date, count] of [["2026-10-12", 3], ["2026-10-13", 1], ["2026-10-14", 1], ["2026-10-15", 0], ["2026-10-18", 0]] as const) {
        await expect(page.getByTestId(`column-${date}`).getByRole("button")).toHaveCount(count);
      }
    } else {
      await expect(page.getByTestId("agenda-item")).toHaveCount(5);
    }
    await page.getByRole("button", { name: "Next week" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Week of Mon 19 Oct");
    await expect(page.getByText("No bookings this week.")).toBeVisible();
  });

  test("moves between days and opens the day from the address", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDay(page, account, "date=2026-10-13");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tuesday 13 Oct");
    await expect(booking(page, "Lakshmi V", "10:00 am – 11:00 am", "Completed")).toBeVisible();
    await page.getByRole("button", { name: "Previous day" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Monday 12 Oct");
    await expect(booking(page, "Karthik R", "10:00 am – 11:00 am", "Confirmed")).toBeVisible();
    await page.getByRole("button", { name: "Next day" }).click();
    await page.getByRole("button", { name: "Next day" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wednesday 14 Oct");
    await page.getByLabel("Go to").fill("2026-10-20");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tuesday 20 Oct");
    await expect(page.getByTestId("calendar-empty")).toHaveText("No bookings on this day.");
  });

  test("a business with no staff or resources is pointed to booking setup", async ({ page, request }) => {
    const account = await newDay3Account(request);
    await openDay(page, account);
    await expect(page.getByText("No staff or resources yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open booking setup" })).toHaveAttribute("href", "/dashboard/settings/booking");
    await expectNoHorizontalOverflow(page);
  });

  test("a failed read says so and offers to try again", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, error: "bookings" });
    await openDay(page, account);
    await expect(appAlert(page)).toContainText("Couldn't load the calendar");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});

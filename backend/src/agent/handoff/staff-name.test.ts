import { beforeEach, describe, expect, it, vi } from "vitest";

// The name a customer reads for the staff member who takes their chat (takeover.ts, external-notice.ts): the first name from the account's own profile, or none. Never the start of an
// email address, which would show a customer something like "nithishareddy113 from Acme". With none, the words name the business instead (texts.ts).

const getUserById = vi.fn();
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: () => ({ auth: { admin: { getUserById } } }) }));

import { lookupStaffName, staffFirstName } from "./staff-name";

describe("the first name", () => {
  it("is the first word of the full name, or of the name", () => {
    expect(staffFirstName({ full_name: "Priya Sharma" })).toBe("Priya");
    expect(staffFirstName({ name: "Ravi Kumar" })).toBe("Ravi");
    expect(staffFirstName({ full_name: "  Anand   K " })).toBe("Anand");
  });

  it("prefers the full name, and falls through an empty or non-text one", () => {
    expect(staffFirstName({ full_name: "Priya", name: "Other" })).toBe("Priya");
    expect(staffFirstName({ full_name: "   ", name: "Ravi" })).toBe("Ravi");
    expect(staffFirstName({ full_name: 42, name: "Ravi" })).toBe("Ravi");
  });

  it("keeps Tamil and Hindi names, and cuts a very long one", () => {
    expect(staffFirstName({ full_name: "பிரியா குமார்" })).toBe("பிரியா");
    expect(staffFirstName({ full_name: "प्रिया शर्मा" })).toBe("प्रिया");
    expect([...(staffFirstName({ full_name: "P".repeat(200) }) ?? "")].length).toBeLessThanOrEqual(40);
  });

  it.each([undefined, null, {}, [], "text", { full_name: "" }, { full_name: "priya@example.com" }, { full_name: "9876543210" }, { full_name: "https://evil.example" }, { name: "@priya" }])(
    "is none when there is nothing usable in it (%j)",
    (meta) => {
      expect(staffFirstName(meta)).toBeNull();
    },
  );
});

describe("the lookup", () => {
  beforeEach(() => getUserById.mockReset());

  it("reads the account's profile name", async () => {
    getUserById.mockResolvedValue({ data: { user: { user_metadata: { full_name: "Priya Sharma" }, email: "p@example.com" } }, error: null });
    expect(await lookupStaffName("u1")).toBe("Priya");
  });

  it("is none for an account with only an email: the start of an email address is never shown to a customer", async () => {
    getUserById.mockResolvedValue({ data: { user: { user_metadata: {}, email: "nithishareddy113@example.com" } }, error: null });
    expect(await lookupStaffName("u1")).toBeNull();
  });

  it("is none when the account cannot be read", async () => {
    getUserById.mockResolvedValue({ data: { user: null }, error: { message: "nope" } });
    expect(await lookupStaffName("u1")).toBeNull();
    getUserById.mockResolvedValue({ data: { user: null }, error: null });
    expect(await lookupStaffName("u1")).toBeNull();
  });
});

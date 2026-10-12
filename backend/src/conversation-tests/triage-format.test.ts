import { describe, expect, it } from "vitest";
import { MAX_LINE_CHARS, MAX_MESSAGES, maskPhones, parseKbFile, parseTriageFile } from "./triage-format";

// The pasted file of real chats: one customer message per line, a blank line between chats.

describe("parseTriageFile", () => {
  it("reads one message per line and starts a new chat at each blank line", () => {
    const { chats } = parseTriageFile("hi\n2BHK price enna?\n\nvisit venum\n");
    expect(chats).toEqual([
      { name: "chat 1", messages: ["hi", "2BHK price enna?"] },
      { name: "chat 2", messages: ["visit venum"] },
    ]);
  });

  it("takes a chat's name from a '# name:' line and ignores every other comment", () => {
    const { chats } = parseTriageFile("# pasted 12 Oct from Raja\n# name: Velachery enquiry\nhi\nprice?\n\n# a note\nsecond chat\n");
    expect(chats.map((c) => c.name)).toEqual(["Velachery enquiry", "chat 2"]);
    expect(chats[1].messages).toEqual(["second chat"]);
  });

  it("copes with Windows line endings, extra blank lines, spaces around a line and a missing final newline", () => {
    const { chats } = parseTriageFile("\r\n\r\n  hi  \r\n\r\n\r\n\r\nbye");
    expect(chats).toEqual([
      { name: "chat 1", messages: ["hi"] },
      { name: "chat 2", messages: ["bye"] },
    ]);
  });

  it("keeps Tamil script, Tanglish and emoji exactly as pasted", () => {
    const text = "வணக்கம், 2BHK விலை என்ன?\nanna Velachery la irukka? 🙏";
    expect(parseTriageFile(text).chats[0].messages).toEqual(text.split("\n"));
  });

  it("refuses a file with no messages, saying so", () => {
    for (const text of ["", "\n\n", "# only a comment\n"]) expect(() => parseTriageFile(text)).toThrow(/no messages/i);
  });

  it("refuses too many messages or a line that is too long, naming the line", () => {
    expect(() => parseTriageFile(Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => `m${i}`).join("\n"))).toThrow(/more than 200 messages/);
    expect(() => parseTriageFile(`ok\n${"x".repeat(MAX_LINE_CHARS + 1)}`)).toThrow(/line 2 .*1000/i);
  });

  it("keeps a message that starts with # but is not a comment (a comment is '#' then a space)", () => {
    const { chats } = parseTriageFile("#2BHK price?\n#1 interested\n# a comment\n#\nreal");
    expect(chats[0].messages).toEqual(["#2BHK price?", "#1 interested", "real"]);
  });

  it("masks a number in a chat's name too", () => {
    expect(parseTriageFile("# name: Ramesh 98765 43210\nhi").chats[0].name).toBe("Ramesh [phone]");
  });

  it("masks Indian mobile numbers before anything is run or printed, and keeps them with keepNumbers", () => {
    const text = "call me on 98765 43210 or +91 9876543210 please";
    expect(parseTriageFile(text).chats[0].messages[0]).toBe("call me on [phone] or [phone] please");
    expect(parseTriageFile(text, { keepNumbers: true }).chats[0].messages[0]).toBe(text);
  });
});

describe("maskPhones", () => {
  it("masks a ten-digit mobile number in every common spelling", () => {
    for (const phone of ["9876543210", "98765 43210", "98765-43210", "+919876543210", "+91 98765 43210", "91-9876543210", "98 7654 3210", "9876-543-210", "+91 (98765) 43210", "098765 43210", "98765.43210", "(+91) 98765 43210"]) {
      expect(maskPhones(`x ${phone} y`), phone).toBe("x [phone] y");
    }
  });

  it("leaves prices, areas, years and times alone, including large rupee amounts", () => {
    for (const text of ["budget 60 lakh", "₹7800000", "12000000 rupees", "950 sq ft", "2026", "3:30 pm", "1.2 crore", "pincode 600042", "78,00,000", "10-12-2026", "1234567890", "5555 5555 55"]) expect(maskPhones(text)).toBe(text);
  });
});

describe("parseKbFile", () => {
  it("reads one fact per non-blank line, skipping comments", () => {
    expect(parseKbFile("# facts\n2BHK starts at ₹78 lakh.\n\nSite visits are on weekends.\r\n")).toEqual(["2BHK starts at ₹78 lakh.", "Site visits are on weekends."]);
  });

  it("allows an empty knowledge base (every question then has no answer)", () => {
    expect(parseKbFile("")).toEqual([]);
  });
});

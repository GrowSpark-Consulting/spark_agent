import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildExtractionSystem } from "./extraction_v1";
import { buildExtractionSystem as buildExtractionSystemV2 } from "./extraction_v2";
import { buildReplySystem } from "./reply_v1";
import { buildReplySystem as buildReplySystemV2 } from "./reply_v2";

// A prompt that is in use is never edited: a change is a new version (extraction_v2.ts, reply_v2.ts), so a trace
// that says "reply_v1" always means the same words. This test holds the words of the fixed parts of each prompt
// by their hash. If it fails you have edited a prompt in place. Do not just update the hash: copy the file to the
// next version, change the copy, and add a fingerprint for it here.

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

describe("prompt fingerprints", () => {
  it("extraction_v1: the rules (and the way a pack's fields are described) are unchanged", () => {
    const withFields = buildExtractionSystem({ fields: [{ key: "k", label: "L", type: "enum", required: true, options: ["a", "b"] }] });
    expect(sha(withFields.map((b) => b.text).join("\n---\n"))).toBe("400106e80f638183");
  });

  it("extraction_v2: the rules, the exit examples and the way a pack's fields are described are unchanged", () => {
    const withFields = buildExtractionSystemV2({ fields: [{ key: "k", label: "L", type: "enum", required: true, options: ["a", "b"] }] });
    expect(sha(withFields.map((b) => b.text).join("\n---\n"))).toBe("226b67567e623565");
  });

  it("reply_v1: the rules and both tones are unchanged", () => {
    const friendly = buildReplySystem({ businessName: "X", persona: "Y", tone: "friendly" });
    const formal = buildReplySystem({ businessName: "X", tone: "formal" });
    expect(sha([friendly[0].text, friendly[1].text, formal[1].text].join("\n---\n"))).toBe("53c2b09db0bdc8ed");
  });

  it("reply_v2: the rules (with the human-voice rule) and both tones are unchanged", () => {
    const friendly = buildReplySystemV2({ businessName: "X", persona: "Y", tone: "friendly" });
    const formal = buildReplySystemV2({ businessName: "X", tone: "formal" });
    expect(sha([friendly[0].text, friendly[1].text, formal[1].text].join("\n---\n"))).toBe("a6e7a64e08906371");
  });
});

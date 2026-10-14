import { describe, expect, it, vi } from "vitest";
import { keyedMessageId } from "../../notify/send";
import { replyKey } from "./reply";
import { createSentReplyRecorded, replyRecordIds } from "./reply-record";

// How the failure handler tells that a reply for a turn was recorded by notify.send even when the reply step's own marker and answered rows were lost
// (reply.ts answerAfterFailure). notify.send gives a send under an idempotency key the message id keyedMessageId(business, kind, key), and the reply is
// sent under `reply:<id of the turn's last message>`; a send that fell back to the template (the window closed mid-send) is recorded under `<key>#template`.

const T = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const M2 = "a0000000-0000-0000-0000-0000000000a2";

describe("the key derivation the check relies on (Dev 2's notify.send, pinned here: if it changes, S3 of the failure handler silently stops matching)", () => {
  it("the reply's key is reply:<message id>", () => {
    expect(replyKey(M1)).toBe(`reply:${M1}`);
  });

  it("the id notify.send gives a message sent under that key, and under its template fallback key, are these exact values", () => {
    expect(keyedMessageId(T, "ai_reply", replyKey(M1))).toBe("920a027e-6b11-50c5-847c-16d2b620a79e");
    expect(keyedMessageId(T, "ai_reply", `${replyKey(M1)}#template`)).toBe("78e5eae4-3d34-557c-a246-fa8d874a460d");
  });

  it("depends on the business and the kind: another business, or another kind, gets another id", () => {
    expect(keyedMessageId("e0000000-0000-0000-0000-00000000000b", "ai_reply", replyKey(M1))).not.toBe(keyedMessageId(T, "ai_reply", replyKey(M1)));
    expect(keyedMessageId(T, "system_notice", replyKey(M1))).not.toBe(keyedMessageId(T, "ai_reply", replyKey(M1)));
  });
});

describe("replyRecordIds", () => {
  it("is both ids (the key and its template fallback) for each message, in order", () => {
    expect(replyRecordIds(T, [M1, M2])).toEqual([
      keyedMessageId(T, "ai_reply", replyKey(M1)),
      keyedMessageId(T, "ai_reply", `${replyKey(M1)}#template`),
      keyedMessageId(T, "ai_reply", replyKey(M2)),
      keyedMessageId(T, "ai_reply", `${replyKey(M2)}#template`),
    ]);
  });

  it("is nothing for no messages, and looks at no more than the newest 10 (a burst is answered from its newest ten)", () => {
    expect(replyRecordIds(T, [])).toEqual([]);
    const many = Array.from({ length: 14 }, (_, i) => `a0000000-0000-0000-0000-0000000001${String(i).padStart(2, "0")}`);
    const ids = replyRecordIds(T, many);
    expect(ids).toHaveLength(20);
    expect(ids).toContain(keyedMessageId(T, "ai_reply", replyKey(many[13]))); // the newest
    expect(ids).not.toContain(keyedMessageId(T, "ai_reply", replyKey(many[0])));
  });
});

describe("createSentReplyRecorded", () => {
  it("asks the store, for this business and this chat, which of those ids are recorded messages, and says WHICH customer messages a recorded reply belongs to", async () => {
    const recordedMessageIds = vi.fn(async () => [keyedMessageId(T, "ai_reply", replyKey(M2))]);
    const recorded = createSentReplyRecorded({ recordedMessageIds });
    expect(await recorded(T, CONV, [M1, M2])).toEqual([M2]);
    expect(recordedMessageIds).toHaveBeenCalledWith(T, CONV, replyRecordIds(T, [M1, M2]));
  });

  it("a reply recorded under the template fallback key belongs to its message too", async () => {
    const recorded = createSentReplyRecorded({ recordedMessageIds: async () => [keyedMessageId(T, "ai_reply", `${replyKey(M1)}#template`)] });
    expect(await recorded(T, CONV, [M1, M2])).toEqual([M1]);
  });

  it("is nothing when none is there, and does not ask at all for no messages", async () => {
    const recordedMessageIds = vi.fn(async () => [] as string[]);
    const recorded = createSentReplyRecorded({ recordedMessageIds });
    expect(await recorded(T, CONV, [M1])).toEqual([]);
    recordedMessageIds.mockClear();
    expect(await recorded(T, CONV, [])).toEqual([]);
    expect(recordedMessageIds).not.toHaveBeenCalled();
  });

  it("does not hide a store that cannot be read: it throws, and the handler decides (it fails open)", async () => {
    const recorded = createSentReplyRecorded({ recordedMessageIds: async () => Promise.reject(new Error("db down")) });
    await expect(recorded(T, CONV, [M1])).rejects.toThrow("db down");
  });
});

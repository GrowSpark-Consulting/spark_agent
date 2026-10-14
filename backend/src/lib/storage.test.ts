import { describe, expect, it } from "vitest";
import { MESSAGE_MEDIA_BUCKET, mediaExtension, messageMediaPath } from "./storage";

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const CONV = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const MESSAGE = "8e9f0a1b-2c3d-4e5f-8a7b-9c0d1e2f3a4b";

describe("message media (0047)", () => {
  it("is the private bucket message-media, at <tenant_id>/<conversation_id>/<message_id>.<ext>", () => {
    expect(MESSAGE_MEDIA_BUCKET).toBe("message-media");
    expect(messageMediaPath(TENANT, CONV, MESSAGE, "jpg")).toBe(`${TENANT}/${CONV}/${MESSAGE}.jpg`);
    expect(messageMediaPath(TENANT.toUpperCase(), CONV, MESSAGE, "pdf")).toBe(`${TENANT}/${CONV}/${MESSAGE}.pdf`);
  });

  it("refuses anything that could step outside the business's folder", () => {
    expect(() => messageMediaPath("../other", CONV, MESSAGE, "jpg")).toThrow("business id");
    expect(() => messageMediaPath(TENANT, "x/../../y", MESSAGE, "jpg")).toThrow("conversation id");
    expect(() => messageMediaPath(TENANT, CONV, `${MESSAGE}/..`, "jpg")).toThrow("message id");
    expect(() => messageMediaPath(TENANT, CONV, MESSAGE, "jpg/../x")).toThrow("extension");
    expect(() => messageMediaPath(TENANT, CONV, MESSAGE, "")).toThrow("extension");
  });

  it("names the extension from WhatsApp's media type, codecs and case aside", () => {
    expect(mediaExtension("image/jpeg")).toBe("jpg");
    expect(mediaExtension("audio/ogg; codecs=opus")).toBe("ogg");
    expect(mediaExtension("Application/PDF")).toBe("pdf");
    expect(mediaExtension("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(mediaExtension("application/x-something")).toBe("bin");
    expect(mediaExtension(null)).toBe("bin");
  });
});

import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { stripOlderImages, dataUrlMediaType, OMITTED_SNAPSHOT_TEXT } from "@/components/chat/strip-images";
import { forNextTurn } from "@/components/chat/next-turn";

type Part = Record<string, unknown>;
const JPEG = "data:image/jpeg;base64,/9j/AAAA";
const imagePart = (url = JPEG): Part => ({ type: "file", url, mediaType: "image/png" });
const userMsg = (id: string, text: string, image?: string) =>
  ({
    id,
    role: "user",
    parts: image ? [{ type: "text", text }, imagePart(image)] : [{ type: "text", text }],
  }) as unknown as UIMessage;
const assistantMsg = (id: string) =>
  ({ id, role: "assistant", parts: [{ type: "text", text: "ok" }, imagePart()] }) as unknown as UIMessage;
const partsOf = (m: UIMessage) => m.parts as unknown as Part[];

describe("dataUrlMediaType", () => {
  it("reads the media type of a data URL", () => {
    expect(dataUrlMediaType(JPEG)).toBe("image/jpeg");
    expect(dataUrlMediaType("data:image/png,abc")).toBe("image/png");
    expect(dataUrlMediaType("https://example.com/x.png")).toBeNull();
  });
});

describe("stripOlderImages", () => {
  it("keeps images on the newest user message and replaces older ones with a placeholder", () => {
    const input = [userMsg("u1", "make a box", JPEG), assistantMsg("a1"), userMsg("u2", "thinner", JPEG)];
    const out = stripOlderImages(input);

    expect(partsOf(out[0])).toEqual([
      { type: "text", text: "make a box" },
      { type: "text", text: OMITTED_SNAPSHOT_TEXT },
    ]);
    // Newest keeps its image, with the media type taken from the data URL.
    expect(partsOf(out[2])).toEqual([
      { type: "text", text: "thinner" },
      { type: "file", url: JPEG, mediaType: "image/jpeg" },
    ]);
    // Assistant messages are never touched.
    expect(out[1]).toBe(input[1]);
  });

  it("applies to older turns even when the newest user message has no image", () => {
    const out = stripOlderImages([userMsg("u1", "a", JPEG), assistantMsg("a1"), userMsg("u2", "b")]);
    expect(partsOf(out[0]).some((p) => p.type === "file")).toBe(false);
  });

  it("is idempotent and does not stack placeholders", () => {
    const input = [userMsg("u1", "a", JPEG), userMsg("u2", "b", JPEG)];
    const once = stripOlderImages(input);
    const twice = stripOlderImages(once);
    expect(twice).toBe(once);
    expect(partsOf(twice[0]).filter((p) => p.text === OMITTED_SNAPSHOT_TEXT)).toHaveLength(1);
  });

  it("returns the input array untouched when there are no images", () => {
    const input = [userMsg("u1", "a"), userMsg("u2", "b")];
    expect(stripOlderImages(input)).toBe(input);
  });

  it("drops the newest image too with keepLatest: false", () => {
    const out = stripOlderImages([userMsg("u1", "a", JPEG)], { keepLatest: false });
    expect(partsOf(out[0])).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: OMITTED_SNAPSHOT_TEXT },
    ]);
  });

  it("recognizes image parts by data URL when the media type is missing", () => {
    const msg = { id: "u1", role: "user", parts: [{ type: "file", url: JPEG }] } as unknown as UIMessage;
    const out = stripOlderImages([msg, userMsg("u2", "b")]);
    expect(partsOf(out[0])).toEqual([{ type: "text", text: OMITTED_SNAPSHOT_TEXT }]);
  });

  it("leaves non-image file parts alone", () => {
    const pdf = { type: "file", url: "data:application/pdf;base64,AAA", mediaType: "application/pdf" };
    const msg = { id: "u1", role: "user", parts: [pdf] } as unknown as UIMessage;
    const input = [msg, userMsg("u2", "b")];
    expect(stripOlderImages(input)).toBe(input);
  });
});

describe("forNextTurn image stripping", () => {
  it("sends images only with the newest user message", () => {
    const out = forNextTurn([userMsg("u1", "a", JPEG), assistantMsg("a1"), userMsg("u2", "b", JPEG)], "");
    expect(partsOf(out[0]).some((p) => p.type === "file")).toBe(false);
    expect(partsOf(out[2]).some((p) => p.type === "file")).toBe(true);
  });
});

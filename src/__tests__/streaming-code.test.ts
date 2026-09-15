import { describe, expect, it } from "vitest";
import { extractStreamingCode } from "@/components/chat/streaming-code";

describe("extractStreamingCode", () => {
  it("returns empty string for empty or code-less input", () => {
    expect(extractStreamingCode("")).toBe("");
    expect(extractStreamingCode('{"other":"value"}')).toBe("");
  });

  it("extracts a complete code value", () => {
    expect(extractStreamingCode('{"code":"import cadquery"}')).toBe("import cadquery");
  });

  it("extracts a partial value while the JSON is still streaming", () => {
    expect(extractStreamingCode('{"code":"import cadq')).toBe("import cadq");
  });

  it("unescapes JSON escape sequences", () => {
    expect(extractStreamingCode('{"code":"line1\\nline2"}')).toBe("line1\nline2");
    expect(extractStreamingCode('{"code":"say \\"hi\\""}')).toBe('say "hi"');
  });

  it("stops at the unescaped closing quote", () => {
    expect(extractStreamingCode('{"code":"abc"},"next":"x"')).toBe("abc");
  });

  it("returns the raw slice when the partial escape can't parse", () => {
    // A trailing lone backslash makes the JSON.parse of the fragment fail.
    expect(extractStreamingCode('{"code":"abc\\')).toBe("abc\\");
  });
});

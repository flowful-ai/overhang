import { describe, it, expect } from "vitest";
import { normalizePunctuation } from "@/lib/llm-code";

describe("normalizePunctuation", () => {
  it("replaces em-dash, en-dash, minus sign with hyphen", () => {
    expect(normalizePunctuation("# mm — width")).toBe("# mm - width");
    expect(normalizePunctuation("# mm – width")).toBe("# mm - width");
    expect(normalizePunctuation("# mm − width")).toBe("# mm - width");
  });

  it("replaces curly quotes with straight quotes", () => {
    expect(normalizePunctuation("“hello”")).toBe('"hello"');
    expect(normalizePunctuation("don’t")).toBe("don't");
  });

  it("replaces ellipsis and non-breaking space", () => {
    expect(normalizePunctuation("wait…")).toBe("wait...");
    expect(normalizePunctuation("a b")).toBe("a b");
  });

  it("leaves the ASCII backtick alone (it can be part of a string literal)", () => {
    const code = 'label = "use `cq` here"  # mm - see `docs`';
    expect(normalizePunctuation(code)).toBe(code);
  });

  it("is a no-op on ASCII input", () => {
    expect(normalizePunctuation("import cadquery as cq # mm - width")).toBe("import cadquery as cq # mm - width");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { base64ToBlob, APP_CONSTANTS, ALLOWED_MODEL_IDS, MODELS } from "@/lib/utils";

describe("APP_CONSTANTS", () => {
  it("exposes expected constants", () => {
    expect(APP_CONSTANTS.MAX_PROMPT_LENGTH).toBe(10000);
    expect(APP_CONSTANTS.MAX_CODE_LENGTH).toBe(50_000);
    expect(APP_CONSTANTS.STL_MIME_TYPE).toBe("application/sla");
  });
});

describe("MODELS / ALLOWED_MODEL_IDS", () => {
  it("ALLOWED_MODEL_IDS is derived from MODELS", () => {
    expect(ALLOWED_MODEL_IDS).toEqual(MODELS.map(m => m.id));
  });

  it("default model is gpt-5.6 luna", () => {
    expect(ALLOWED_MODEL_IDS[0]).toBe("openai/gpt-5.6-luna");
  });
});

describe("base64ToBlob", () => {
  beforeEach(() => {
    // Provide a minimal atob shim for Node < 16 / vitest node env
    if (typeof globalThis.atob === "undefined") {
      globalThis.atob = (str: string) => Buffer.from(str, "base64").toString("binary");
    }
    // Provide a minimal Blob shim that records what was passed
    if (typeof globalThis.Blob === "undefined") {
      (globalThis as unknown as { Blob: unknown }).Blob = class {
        parts: BlobPart[];
        type: string;
        size: number;
        constructor(parts: BlobPart[], opts: { type?: string } = {}) {
          this.parts = parts;
          this.type = opts.type || "";
          const bytes = parts[0] as Uint8Array;
          this.size = bytes.length;
        }
      };
    }
    // base64ToBlob references `window.atob`, so expose it
    (globalThis as unknown as { window: unknown }).window = { atob: globalThis.atob };
  });

  it("decodes base64 to a Blob of the right size", () => {
    const input = Buffer.from("Hello, World!").toString("base64");
    const blob = base64ToBlob(input, "text/plain");
    expect(blob.size).toBe(13);
    expect(blob.type).toBe("text/plain");
  });

  it("defaults to octet-stream mime type", () => {
    const blob = base64ToBlob(Buffer.from("x").toString("base64"));
    expect(blob.type).toBe("application/octet-stream");
  });
});

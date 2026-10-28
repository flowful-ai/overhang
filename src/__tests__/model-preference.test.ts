import { describe, it, expect } from "vitest";
import { MODEL_STORAGE_KEY, loadModelPreference, rememberModelChoice, saveModelPreference } from "@/components/chat/model-preference";
import { MODELS } from "@/lib/utils";

// The remembered model choice: kept across New Chat, validated against MODELS.

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const DEFAULT = MODELS[0].id;
const OTHER = MODELS[1].id;

describe("model preference", () => {
  it("defaults to the first model", () => {
    expect(loadModelPreference(() => memoryStorage())).toBe(DEFAULT);
  });

  it("round-trips a listed model", () => {
    const storage = memoryStorage();
    saveModelPreference(OTHER, () => storage);
    expect(storage.data.get(MODEL_STORAGE_KEY)).toBe(OTHER);
    expect(loadModelPreference(() => storage)).toBe(OTHER);
  });

  it("falls back to the default for an id no longer in MODELS", () => {
    expect(loadModelPreference(() => memoryStorage({ [MODEL_STORAGE_KEY]: "retired/model" }))).toBe(DEFAULT);
  });

  it("never stores an unlisted id", () => {
    const storage = memoryStorage();
    saveModelPreference("retired/model", () => storage);
    expect(storage.data.get(MODEL_STORAGE_KEY)).toBe(DEFAULT);
  });

  it("applies and remembers a header pick", () => {
    const storage = memoryStorage();
    const applied: string[] = [];
    rememberModelChoice(OTHER, (id) => applied.push(id), () => storage);
    expect(applied).toEqual([OTHER]);
    expect(storage.data.get(MODEL_STORAGE_KEY)).toBe(OTHER);
    expect(loadModelPreference(() => storage)).toBe(OTHER);
  });

  it("applies and remembers the default for an unlisted pick", () => {
    const storage = memoryStorage();
    const applied: string[] = [];
    rememberModelChoice("retired/model", (id) => applied.push(id), () => storage);
    expect(applied).toEqual([DEFAULT]);
    expect(storage.data.get(MODEL_STORAGE_KEY)).toBe(DEFAULT);
  });

  it("still applies a pick when storage is unavailable", () => {
    const applied: string[] = [];
    rememberModelChoice(OTHER, (id) => applied.push(id), () => {
      throw new Error("SecurityError");
    });
    expect(applied).toEqual([OTHER]);
  });

  it("falls back to the default and does not throw when storage is unavailable", () => {
    const blocked = () => {
      throw new Error("SecurityError");
    };
    expect(loadModelPreference(blocked)).toBe(DEFAULT);
    expect(() => saveModelPreference(OTHER, blocked)).not.toThrow();
  });
});

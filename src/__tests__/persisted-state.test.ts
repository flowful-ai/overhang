import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  toRepository,
  prepareForStorage,
  isQuotaExceeded,
  persistFailureMessage,
  activeBranch,
  saveThread,
  createOnceReporter,
  type PersistedRepository,
} from "@/components/chat/persisted-state";
import { TOOL_NAME, STORAGE_KEY } from "@/components/chat/constants";
import { OMITTED_SNAPSHOT_TEXT } from "@/components/chat/strip-images";

type Part = Record<string, unknown>;
const JPEG = "data:image/jpeg;base64,/9j/AAAA";
const user = (id: string, image = false) =>
  ({
    id,
    role: "user",
    parts: image ? [{ type: "text", text: id }, { type: "file", url: JPEG, mediaType: "image/jpeg" }] : [{ type: "text", text: id }],
  }) as unknown as UIMessage;
const assistant = (id: string) =>
  ({
    id,
    role: "assistant",
    parts: [{ type: `tool-${TOOL_NAME}`, toolCallId: "c", output: { success: true, code: "x", stlBase64: "STL" } }],
  }) as unknown as UIMessage;
const partsOf = (m: UIMessage) => m.parts as unknown as Part[];

describe("toRepository", () => {
  it("passes through the runtime's repository shape", () => {
    const repo = {
      headId: "a1",
      messages: [
        { parentId: null, message: user("u1") },
        { parentId: "u1", message: assistant("a1") },
      ],
    };
    expect(toRepository(repo)).toEqual(repo);
  });

  it("defaults a missing head to the last message and drops malformed items", () => {
    const repo = toRepository({
      messages: [{ parentId: null, message: user("u1") }, { parentId: "u1", message: { id: 1 } }, null],
    });
    expect(repo).toEqual({ headId: "u1", messages: [{ parentId: null, message: user("u1") }] });
  });

  it("links a bare UIMessage[] in order", () => {
    expect(toRepository([user("u1"), assistant("a1")])).toEqual({
      headId: "a1",
      messages: [
        { parentId: null, message: user("u1") },
        { parentId: "u1", message: assistant("a1") },
      ],
    });
  });

  it("returns null for unusable input", () => {
    expect(toRepository(undefined)).toBeNull();
    expect(toRepository("nope")).toBeNull();
    expect(toRepository([])).toBeNull();
    expect(toRepository({ messages: [] })).toBeNull();
  });
});

describe("prepareForStorage", () => {
  const repo = toRepository([user("u1", true), assistant("a1"), user("u2", true)])!;

  it("strips STL and keeps only the newest image, preserving links", () => {
    const out = prepareForStorage(repo);
    expect(out.headId).toBe("u2");
    expect(out.messages.map((m) => m.parentId)).toEqual([null, "u1", "a1"]);
    expect(partsOf(out.messages[0].message)).toContainEqual({ type: "text", text: OMITTED_SNAPSHOT_TEXT });
    expect((partsOf(out.messages[1].message)[0].output as Record<string, unknown>).stlBase64).toBeUndefined();
    expect(partsOf(out.messages[2].message).some((p) => p.type === "file")).toBe(true);
  });

  it("drops every image with keepLatestImage: false", () => {
    const out = prepareForStorage(repo, { keepLatestImage: false });
    expect(out.messages.every((m) => !partsOf(m.message).some((p) => p.type === "file"))).toBe(true);
  });

  it("round-trips through JSON into an importable repository", () => {
    const out = prepareForStorage(repo);
    expect(toRepository(JSON.parse(JSON.stringify(out)))).toEqual(out);
  });
});

// A Retry after a mid-stream failure: the failed reply a1 stays in the
// exported repository as a sibling of the regenerated a1b, which is the head.
const retried = (): PersistedRepository => ({
  headId: "a1b",
  messages: [
    { parentId: null, message: user("u0", true) },
    { parentId: "u0", message: assistant("a0") },
    { parentId: "a0", message: user("u1", true) },
    { parentId: "u1", message: assistant("a1") },
    { parentId: "a1", message: user("u2-abandoned", true) },
    { parentId: "u1", message: assistant("a1b") },
  ],
});

describe("activeBranch", () => {
  it("keeps only the path from the root to the head", () => {
    const branch = activeBranch(retried());
    expect(branch.headId).toBe("a1b");
    expect(branch.messages.map((m) => [m.parentId, m.message.id])).toEqual([
      [null, "u0"],
      ["u0", "a0"],
      ["a0", "u1"],
      ["u1", "a1b"],
    ]);
  });

  it("falls back to the last message when the head is unknown", () => {
    const branch = activeBranch({ ...retried(), headId: "missing" });
    expect(branch.messages.map((m) => m.message.id)).toEqual(["u0", "a0", "u1", "a1b"]);
  });

  it("is safe against parent cycles", () => {
    const branch = activeBranch({
      headId: "b",
      messages: [
        { parentId: "b", message: user("a") },
        { parentId: "a", message: user("b") },
      ],
    });
    expect(branch.messages.map((m) => m.message.id)).toEqual(["a", "b"]);
  });

  it("drives prepareForStorage: abandoned branch dropped, newest user image picked on the active branch", () => {
    const out = prepareForStorage(retried());
    const ids = out.messages.map((m) => m.message.id);
    expect(ids).toEqual(["u0", "a0", "u1", "a1b"]);
    // u2-abandoned is newer in array order, but u1 is the newest user message on the branch.
    const u1 = out.messages[2].message;
    expect(partsOf(u1).some((p) => p.type === "file")).toBe(true);
    expect(partsOf(out.messages[0].message)).toContainEqual({ type: "text", text: OMITTED_SNAPSHOT_TEXT });
  });
});

class FakeStorage {
  data = new Map<string, string>([[STORAGE_KEY, "stale"]]);
  setCalls: string[] = [];
  removed = 0;
  constructor(private failures: unknown[]) {}
  setItem(key: string, value: string) {
    this.setCalls.push(value);
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.removed++;
    this.data.delete(key);
  }
}

const quota = () => new DOMException("full", "QuotaExceededError");
const stored = (storage: FakeStorage) => JSON.parse(storage.data.get(STORAGE_KEY)!);

describe("saveThread", () => {
  const exported = () => retried();

  it("saves the stripped active branch with the model", () => {
    const storage = new FakeStorage([]);
    expect(saveThread(storage, exported(), "m1")).toEqual({ status: "saved" });
    const state = stored(storage);
    expect(state.model).toBe("m1");
    expect(state.messages.messages).toHaveLength(4);
    expect(JSON.stringify(state)).not.toContain("STL");
  });

  it("retries without images after a quota error", () => {
    const storage = new FakeStorage([quota()]);
    expect(saveThread(storage, exported(), "m1")).toEqual({ status: "saved-without-images" });
    expect(storage.setCalls).toHaveLength(2);
    expect(storage.setCalls[0]).toContain("data:image/");
    expect(storage.setCalls[1]).not.toContain("data:image/");
    expect(storage.removed).toBe(0);
  });

  it("removes the stale copy when the retry also fails", () => {
    const storage = new FakeStorage([quota(), quota()]);
    const outcome = saveThread(storage, exported(), "m1");
    expect(outcome.status).toBe("failed");
    expect(storage.setCalls).toHaveLength(2);
    expect(storage.removed).toBe(1);
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
  });

  it("does not retry a non-quota failure", () => {
    const storage = new FakeStorage([new DOMException("denied", "SecurityError")]);
    const outcome = saveThread(storage, exported(), "m1");
    expect(outcome.status).toBe("failed");
    expect(storage.setCalls).toHaveLength(1);
    expect(storage.removed).toBe(1);
  });

  it("skips unusable exports without touching storage", () => {
    const storage = new FakeStorage([]);
    expect(saveThread(storage, undefined, "m1")).toEqual({ status: "skipped" });
    expect(storage.setCalls).toHaveLength(0);
    expect(storage.data.get(STORAGE_KEY)).toBe("stale");
  });
});

describe("createOnceReporter", () => {
  it("notifies only the first failure, with copy for its cause", () => {
    const toasts: string[] = [];
    const report = createOnceReporter((m) => toasts.push(m));
    const storage = new FakeStorage([quota(), quota(), quota(), quota()]);
    for (let i = 0; i < 2; i++) {
      const outcome = saveThread(storage, retried(), "m1");
      if (outcome.status === "failed") report(outcome.error);
    }
    expect(toasts).toEqual(["Browser storage is full, so this chat won't be restored after a reload."]);
  });
});

describe("isQuotaExceeded", () => {
  it("recognizes quota errors across browsers", () => {
    expect(isQuotaExceeded(new DOMException("full", "QuotaExceededError"))).toBe(true);
    expect(isQuotaExceeded({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isQuotaExceeded({ code: 22 })).toBe(true);
    expect(isQuotaExceeded({ code: 1014 })).toBe(true);
  });

  it("rejects other errors", () => {
    expect(isQuotaExceeded(new DOMException("denied", "SecurityError"))).toBe(false);
    expect(isQuotaExceeded(new Error("boom"))).toBe(false);
    expect(isQuotaExceeded(null)).toBe(false);
  });

  it("picks the matching toast copy", () => {
    expect(persistFailureMessage({ name: "QuotaExceededError" })).toMatch(/storage is full/);
    expect(persistFailureMessage(new Error("x"))).toMatch(/Couldn't save/);
  });
});

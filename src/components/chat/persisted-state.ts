import type { UIMessage } from "ai";
import { STORAGE_KEY } from "./constants";
import { stripStlFromMessages } from "./strip-stl";
import { stripOlderImages } from "./strip-images";

// The message repository the AI SDK runtime exports and imports
// (thread.exportExternalState / importExternalState): a parent-linked tree of
// UIMessages plus the active head. Retries and edits leave sibling branches in
// it (e.g. the failed reply a Retry replaced).
export interface PersistedRepository {
  headId: string | null;
  messages: { parentId: string | null; message: UIMessage }[];
}

function isUiMessage(value: unknown): value is UIMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as { id?: unknown; role?: unknown; parts?: unknown };
  return typeof m.id === "string" && typeof m.role === "string" && Array.isArray(m.parts);
}

/**
 * Normalize stored or exported chat state into a repository the runtime can
 * import. Accepts the repository object and a bare UIMessage[] (an older
 * stored shape, linked in order). Returns null for anything unusable. Pure;
 * unit-tested in persisted-state.test.ts.
 */
export function toRepository(value: unknown): PersistedRepository | null {
  if (Array.isArray(value)) {
    const messages = value.filter(isUiMessage);
    if (messages.length === 0) return null;
    return {
      headId: messages[messages.length - 1].id,
      messages: messages.map((message, i) => ({
        parentId: i === 0 ? null : messages[i - 1].id,
        message,
      })),
    };
  }
  if (value && typeof value === "object" && Array.isArray((value as { messages?: unknown }).messages)) {
    const raw = (value as { messages: unknown[]; headId?: unknown });
    const items = raw.messages.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { parentId, message } = item as { parentId?: unknown; message?: unknown };
      if (!isUiMessage(message)) return [];
      return [{ parentId: typeof parentId === "string" ? parentId : null, message }];
    });
    if (items.length === 0) return null;
    return {
      headId: typeof raw.headId === "string" ? raw.headId : items[items.length - 1].message.id,
      messages: items,
    };
  }
  return null;
}

/**
 * The conversation the user actually sees: walk parentId links back from the
 * head (the last message when the head is unknown) and return that path, root
 * first. Abandoned branches are dropped. Cycle-safe.
 */
export function activeBranch(repo: PersistedRepository): PersistedRepository {
  const byId = new Map(repo.messages.map((m) => [m.message.id, m]));
  const last = repo.messages[repo.messages.length - 1];
  const headId = repo.headId && byId.has(repo.headId) ? repo.headId : (last?.message.id ?? null);
  const chain: PersistedRepository["messages"] = [];
  const seen = new Set<string>();
  let id: string | null = headId;
  while (id !== null && byId.has(id) && !seen.has(id)) {
    seen.add(id);
    const item: PersistedRepository["messages"][number] = byId.get(id)!;
    chain.push(item);
    id = item.parentId;
  }
  chain.reverse();
  return {
    headId,
    messages: chain.map((m, i) => ({ parentId: i === 0 ? null : chain[i - 1].message.id, message: m.message })),
  };
}

// What gets written to localStorage: the active branch only, no STL bytes,
// and images only on that branch's newest user message (or none, when
// retrying after a quota error).
export function prepareForStorage(
  repo: PersistedRepository,
  { keepLatestImage = true }: { keepLatestImage?: boolean } = {},
): PersistedRepository {
  const branch = activeBranch(repo);
  const stripped = stripStlFromMessages(
    stripOlderImages(branch.messages.map((m) => m.message), { keepLatest: keepLatestImage }),
  );
  return {
    ...branch,
    messages: branch.messages.map((m, i) => ({ ...m, message: stripped[i] })),
  };
}

export function isQuotaExceeded(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { name, code } = err as { name?: unknown; code?: unknown };
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  );
}

export function persistFailureMessage(err: unknown): string {
  return isQuotaExceeded(err)
    ? "Browser storage is full, so this chat won't be restored after a reload."
    : "Couldn't save this chat in your browser, so it won't be restored after a reload.";
}

export type SaveOutcome =
  | { status: "saved" | "saved-without-images" | "skipped" }
  | { status: "failed"; error: unknown };

/**
 * One save of the exported thread. On a quota error, retry once without any
 * image; if saving still fails, remove the stored copy (restoring it would
 * silently drop the turns that failed to save) and report the failure.
 */
export function saveThread(
  storage: Pick<Storage, "setItem" | "removeItem">,
  exported: unknown,
  model: string,
): SaveOutcome {
  const repo = toRepository(exported);
  if (!repo) return { status: "skipped" };
  const write = (keepLatestImage: boolean) =>
    storage.setItem(STORAGE_KEY, JSON.stringify({ messages: prepareForStorage(repo, { keepLatestImage }), model }));
  try {
    write(true);
    return { status: "saved" };
  } catch (err) {
    let failure: unknown = err;
    if (isQuotaExceeded(err)) {
      try {
        write(false);
        return { status: "saved-without-images" };
      } catch (retryErr) {
        failure = retryErr;
      }
    }
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable
    }
    return { status: "failed", error: failure };
  }
}

// Wraps a notifier so only the first persistence failure is surfaced; later
// saves keep failing quietly instead of toasting on every turn.
export function createOnceReporter(notify: (message: string) => void): (err: unknown) => void {
  let reported = false;
  return (err) => {
    if (reported) return;
    reported = true;
    notify(persistFailureMessage(err));
  };
}

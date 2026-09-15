// The user's "Web search" setting, kept in localStorage apart from the chat
// thread so New Chat does not reset it. Default on. Storage access is wrapped:
// reading `localStorage` itself throws when site data is blocked.

export const WEB_SEARCH_STORAGE_KEY = "overhang-web-search";

type GetStorage = () => Pick<Storage, "getItem" | "setItem">;
const browserStorage: GetStorage = () => localStorage;

export function loadWebSearchPreference(getStorage: GetStorage = browserStorage): boolean {
  try {
    return getStorage().getItem(WEB_SEARCH_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveWebSearchPreference(enabled: boolean, getStorage: GetStorage = browserStorage): void {
  try {
    getStorage().setItem(WEB_SEARCH_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // storage unavailable: the setting lasts for this page only
  }
}

export interface WebSearchToggleState {
  /** Shown as on: search will actually run for the next turn. */
  checked: boolean;
  disabled: boolean;
  hint: string;
}

/**
 * What the Settings switch shows. Unavailable (server off, or the selected
 * model has no search) renders disabled and off, without touching the stored
 * preference, so switching back to a model with search restores it.
 */
export function webSearchToggleState({
  serverAvailable,
  modelSupported,
  preference,
}: {
  serverAvailable: boolean;
  modelSupported: boolean;
  preference: boolean;
}): WebSearchToggleState {
  if (!serverAvailable) return { checked: false, disabled: true, hint: "Disabled on this server" };
  if (!modelSupported) return { checked: false, disabled: true, hint: "Not available for this model" };
  return { checked: preference, disabled: false, hint: "Looks up real product dimensions" };
}

import { allowedModelId } from "@/lib/utils";

// The user's model choice, kept in localStorage apart from the chat thread so
// New Chat does not reset it. Any stored id is checked against MODELS: an id
// dropped from the dropdown falls back to the default. Storage access is
// wrapped: reading `localStorage` itself throws when site data is blocked.

export const MODEL_STORAGE_KEY = "overhang-model";

type GetStorage = () => Pick<Storage, "getItem" | "setItem">;
const browserStorage: GetStorage = () => localStorage;

export function loadModelPreference(getStorage: GetStorage = browserStorage): string {
  try {
    return allowedModelId(getStorage().getItem(MODEL_STORAGE_KEY) ?? undefined);
  } catch {
    return allowedModelId(undefined);
  }
}

export function saveModelPreference(modelId: string, getStorage: GetStorage = browserStorage): void {
  try {
    getStorage().setItem(MODEL_STORAGE_KEY, allowedModelId(modelId));
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
}

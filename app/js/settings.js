// User settings, stored on the phone. The API key never leaves the phone except in requests to Gemini.

const STORAGE_KEY = "fridge-oracle:settings";

export const MODEL_OPTIONS = ["gemini-pro-latest", "gemini-3.1-pro-preview", "gemini-2.5-flash"];

export const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gemini-pro-latest",
  servings: 4,
  dietaryNotes: "",
  mealCount: 4,
};

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/** Returns valid settings, filling in defaults for missing or invalid values. */
export function sanitizeSettings(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    apiKey: String(input.apiKey ?? "").trim(),
    model: String(input.model ?? "").trim() || DEFAULT_SETTINGS.model,
    servings: clampInt(input.servings, 1, 20, DEFAULT_SETTINGS.servings),
    dietaryNotes: String(input.dietaryNotes ?? "").trim(),
    mealCount: clampInt(input.mealCount, 1, 8, DEFAULT_SETTINGS.mealCount),
  };
}

export function loadSettings(storage = globalThis.localStorage) {
  try {
    return sanitizeSettings(JSON.parse(storage.getItem(STORAGE_KEY)));
  } catch {
    return sanitizeSettings(null);
  }
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  const clean = sanitizeSettings(settings);
  storage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

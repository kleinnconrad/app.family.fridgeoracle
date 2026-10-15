// Gemini calls via the REST API: photo analysis and text-only meal planning.
// Runs in the browser and in Node (for tests and the end-to-end script).
// Prompts are written in English; the model answers in German.

import { ALWAYS_AVAILABLE, STAPLE_KEYS } from "./staples.js";

export const OUTPUT_LANGUAGE = "German";
export const DIFFICULTIES = ["easy", "medium", "hard"];

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Pro models always think before answering; a photo analysis can take a minute
const REQUEST_TIMEOUT_MS = 180_000;
const RETRY_STATUS_CODES = [429, 500, 503];
const RETRY_DELAYS_MS = [2_000, 6_000];
// More image tokens per photo: small items and labels are recognized more reliably
const MEDIA_RESOLUTION = "MEDIA_RESOLUTION_HIGH";

const SYSTEM_INSTRUCTION =
  "You are a practical home-cooking assistant for a family. You suggest everyday meals that " +
  "can be cooked in a normal home kitchen with the ingredients that are actually available. " +
  "You never add ingredients that are not explicitly allowed.";

export class GeminiError extends Error {}

// ---------- Response schemas (OpenAPI subset used by the Gemini API) ----------

const MEAL_SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING", description: "Name of the dish" },
    description: { type: "STRING", description: "One sentence describing the dish" },
    fridge_ingredients: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Fridge items the dish uses, spelled exactly as in the ingredient list",
    },
    staples: {
      type: "ARRAY",
      items: { type: "STRING", enum: STAPLE_KEYS },
      description: "Pantry staples the dish needs; empty if none",
    },
    prep_minutes: { type: "INTEGER", description: "Total preparation and cooking time in minutes" },
    difficulty: { type: "STRING", enum: DIFFICULTIES },
    steps: { type: "ARRAY", items: { type: "STRING" }, description: "Short cooking steps, at most 8" },
  },
  required: ["name", "description", "fridge_ingredients", "staples", "prep_minutes", "difficulty", "steps"],
  propertyOrdering: [
    "name",
    "description",
    "fridge_ingredients",
    "staples",
    "prep_minutes",
    "difficulty",
    "steps",
  ],
};

export const ANALYSIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    ingredients: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "Short generic name, e.g. 'Eier', 'Gouda', 'rote Paprika'" },
          quantity: { type: "STRING", description: "Rough visible amount, e.g. 'ca. 6', 'halbe Packung'" },
        },
        required: ["name", "quantity"],
        propertyOrdering: ["name", "quantity"],
      },
    },
    meals: { type: "ARRAY", items: MEAL_SCHEMA },
  },
  required: ["ingredients", "meals"],
  propertyOrdering: ["ingredients", "meals"],
};

export const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: { meals: { type: "ARRAY", items: MEAL_SCHEMA } },
  required: ["meals"],
};

// ---------- Prompts ----------

function bulletList(items) {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)";
}

function rules(preferences, excluded) {
  const notes = preferences.dietaryNotes.trim() || "none";
  return [
    `- Each meal is for ${preferences.servings} people.`,
    `- Dietary notes: ${notes}`,
    "- Prefer meals that use perishable items first (fresh vegetables, meat, fish, open dairy products).",
    "- The meals must differ from each other (different main ingredient, cuisine or cooking method).",
    "- Do not suggest any of the following meals or close variations of them:",
    bulletList(excluded),
    `- Write meal names, descriptions, steps and ingredient names in ${OUTPUT_LANGUAGE}.`,
    '- In "fridge_ingredients", list only fridge items, spelled exactly as in the ingredient list. ' +
      "Do not list the always available basics or pantry staples there.",
    '- In "staples", list only items from the allowed pantry staples that the meal needs.',
  ].join("\n");
}

/** Returns the prompt for the photo analysis. */
export function buildAnalyzePrompt(preferences, mealCount, excluded) {
  return `The attached photos show the inside of a refrigerator (shelves, door, drawers).

Task 1: List every food item you can identify with reasonable confidence, with a rough \
amount. Read the labels on packages to name products precisely (e.g. "Parmaschinken" \
instead of "Aufschnitt", "Sahne" instead of "Milchprodukt"). Ignore non-food items and \
drinks that are not used for cooking. Skip items you cannot identify instead of guessing.

Task 2: Suggest ${mealCount} meals that can be cooked mainly from these fridge items.
A meal may only use:
- the fridge items from task 1,
- these basics, which are always available: ${ALWAYS_AVAILABLE.join(", ")},
- these pantry staples (the user will be asked whether they have them):
${bulletList(STAPLE_KEYS)}
If a pantry staple is visible in the fridge, list it as a fridge item instead.

Rules:
${rules(preferences, excluded)}`;
}

/** Returns the prompt for meal planning from a confirmed ingredient list (no photo). */
export function buildPlanPrompt(preferences, ingredients, availableStaples, mealCount, excluded) {
  const missing = STAPLE_KEYS.filter((staple) => !availableStaples.includes(staple));
  return `Suggest ${mealCount} meals.

Fridge items:
${bulletList(ingredients)}

Always available: ${ALWAYS_AVAILABLE.join(", ")}

Allowed pantry staples:
${bulletList(availableStaples)}

Not available (do not use): ${missing.join(", ") || "none"}

A meal may only use the fridge items, the always available basics and the allowed pantry \
staples. It does not have to use all fridge items.

Rules:
${rules(preferences, excluded)}`;
}

// ---------- Response validation ----------

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

/** Returns a meal with valid field types, or null if the meal has no name. */
export function sanitizeMeal(raw) {
  if (!raw || typeof raw.name !== "string" || !raw.name.trim()) return null;
  const minutes = Number.parseInt(raw.prep_minutes, 10);
  return {
    name: raw.name.trim(),
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    fridge_ingredients: stringList(raw.fridge_ingredients),
    staples: [...new Set(stringList(raw.staples).filter((staple) => STAPLE_KEYS.includes(staple)))],
    prep_minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
    difficulty: DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : "medium",
    steps: stringList(raw.steps),
  };
}

function sanitizeMeals(value) {
  return (Array.isArray(value) ? value : []).map(sanitizeMeal).filter(Boolean);
}

export function sanitizeAnalysis(raw) {
  const ingredients = (Array.isArray(raw?.ingredients) ? raw.ingredients : [])
    .filter((item) => item && typeof item.name === "string" && item.name.trim())
    .map((item) => ({
      name: item.name.trim(),
      quantity: typeof item.quantity === "string" ? item.quantity.trim() : "",
    }));
  return { ingredients, meals: sanitizeMeals(raw?.meals) };
}

export function sanitizePlan(raw) {
  return { meals: sanitizeMeals(raw?.meals) };
}

// ---------- HTTP ----------

function errorForStatus(status, message, model) {
  if (status === 400 && /api key/i.test(message)) return new GeminiError("Der API-Schlüssel ist ungültig.");
  if (status === 403) return new GeminiError("Zugriff verweigert. API-Schlüssel und seine Einschränkungen prüfen.");
  if (status === 404) return new GeminiError(`Das Modell "${model}" wurde nicht gefunden.`);
  if (status === 429) return new GeminiError("Anfragelimit von Gemini erreicht. Bitte später erneut versuchen.");
  return new GeminiError(`Gemini-Fehler (${status}): ${message}`);
}

/** Extracts the JSON answer text from a generateContent response. */
export function responseText(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const reason = data?.promptFeedback?.blockReason;
    throw new GeminiError(`Gemini hat keine Antwort geliefert${reason ? ` (${reason})` : ""}.`);
  }
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new GeminiError(`Die Antwort von Gemini wurde abgebrochen (${candidate.finishReason}).`);
  }
  // Thought summaries are marked with thought: true and are not part of the answer
  return (candidate.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * Creates the Gemini client.
 * @param {object} options
 * @param {string} options.apiKey Gemini API key.
 * @param {string} options.model Model name, e.g. "gemini-pro-latest".
 * @param {{servings: number, dietaryNotes: string}} options.preferences Household settings.
 * @param {typeof fetch} [options.fetchFn] Replaceable in tests.
 * @param {(ms: number) => Promise<void>} [options.sleep] Replaceable in tests.
 */
export function createGemini({
  apiKey,
  model,
  preferences,
  fetchFn = globalThis.fetch.bind(globalThis),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  async function send(body) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchFn(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (error?.name === "TimeoutError") throw new GeminiError("Gemini hat nicht rechtzeitig geantwortet.");
        throw new GeminiError("Keine Verbindung zu Gemini. Internetverbindung prüfen.");
      }
      if (response.ok) return response.json();

      if (RETRY_STATUS_CODES.includes(response.status) && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      let message = response.statusText;
      try {
        message = (await response.json())?.error?.message ?? message;
      } catch {
        // Body is not JSON; keep the status text
      }
      throw errorForStatus(response.status, message, model);
    }
  }

  async function generate(parts, schema, extraConfig = {}) {
    if (!apiKey) throw new GeminiError("Kein API-Schlüssel hinterlegt. Bitte in den Einstellungen eintragen.");
    const data = await send({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, ...extraConfig },
    });
    try {
      return JSON.parse(responseText(data));
    } catch (error) {
      if (error instanceof GeminiError) throw error;
      throw new GeminiError("Gemini hat eine Antwort im falschen Format geliefert.");
    }
  }

  return {
    /**
     * Identifies the fridge contents and drafts meals.
     * @param {{data: string, mimeType: string}[]} photos Base64-encoded photos.
     */
    async analyze(photos, mealCount, excluded) {
      const parts = photos.map((photo) => ({ inlineData: { mimeType: photo.mimeType, data: photo.data } }));
      parts.push({ text: buildAnalyzePrompt(preferences, mealCount, excluded) });
      return sanitizeAnalysis(await generate(parts, ANALYSIS_SCHEMA, { mediaResolution: MEDIA_RESOLUTION }));
    },

    /** Suggests meals from a confirmed ingredient list. */
    async plan(ingredients, availableStaples, mealCount, excluded) {
      const prompt = buildPlanPrompt(preferences, ingredients, availableStaples, mealCount, excluded);
      return sanitizePlan(await generate([{ text: prompt }], PLAN_SCHEMA));
    },
  };
}

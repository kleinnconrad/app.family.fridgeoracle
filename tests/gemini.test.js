import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANALYSIS_SCHEMA,
  GeminiError,
  PLAN_SCHEMA,
  TECHNIQUES,
  buildAnalyzePrompt,
  buildPlanPrompt,
  createGemini,
  responseText,
  sanitizeMeal,
} from "../app/js/gemini.js";
import { loadSettings, sanitizeSettings, saveSettings } from "../app/js/settings.js";
import { RamStorage } from "./helpers.js";

const PREFERENCES = { servings: 3, dietaryNotes: "kein Schwein" };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function answer(payload) {
  return jsonResponse({
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: "thinking...", thought: true }, { text: JSON.stringify(payload) }] },
      },
    ],
  });
}

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return responses.shift();
  };
  return { fn, calls };
}

const noSleep = async () => {};

test("analyze sends photos, prompt, schema and high media resolution", async () => {
  const fetch = fakeFetch([
    answer({
      ingredients: [{ name: "Eier", quantity: "6" }],
      meals: [
        {
          name: "Rührei",
          description: "Schnell.",
          fridge_ingredients: ["Eier"],
          staples: ["onions", "caviar"],
          prep_minutes: 10,
          difficulty: "easy",
          steps: ["Braten."],
        },
      ],
    }),
  ]);
  const gemini = createGemini({ apiKey: "key-1", model: "gemini-pro-latest", preferences: PREFERENCES, fetchFn: fetch.fn });

  const result = await gemini.analyze([{ data: "AAAA", mimeType: "image/jpeg" }], 4, ["Gulasch"]);

  const { url, options, body } = fetch.calls[0];
  assert.match(url, /\/models\/gemini-pro-latest:generateContent$/);
  assert.equal(options.headers["x-goog-api-key"], "key-1");
  assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: "image/jpeg", data: "AAAA" } });
  assert.match(body.contents[0].parts[1].text, /Suggest 4 meals/);
  assert.match(body.contents[0].parts[1].text, /- Gulasch/);
  assert.equal(body.generationConfig.mediaResolution, "MEDIA_RESOLUTION_HIGH");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.ok(body.generationConfig.responseSchema.properties.meals);
  // Unknown staples are removed, thought parts are ignored
  assert.deepEqual(result.meals[0].staples, ["onions"]);
  assert.deepEqual(result.ingredients, [{ name: "Eier", quantity: "6" }]);
});

test("plan sends a text-only request without media resolution", async () => {
  const fetch = fakeFetch([answer({ meals: [] })]);
  const gemini = createGemini({ apiKey: "k", model: "m", preferences: PREFERENCES, fetchFn: fetch.fn });
  await gemini.plan(["Eier"], ["rice"], 2, []);
  const { body } = fetch.calls[0];
  assert.equal(body.contents[0].parts.length, 1);
  assert.equal(body.generationConfig.mediaResolution, undefined);
  assert.match(body.contents[0].parts[0].text, /Not available \(do not use\): onions/);
});

test("missing API key fails before any request", async () => {
  const fetch = fakeFetch([]);
  const gemini = createGemini({ apiKey: "", model: "m", preferences: PREFERENCES, fetchFn: fetch.fn });
  await assert.rejects(gemini.plan([], [], 1, []), (error) => error instanceof GeminiError && /API-Schlüssel/.test(error.message));
  assert.equal(fetch.calls.length, 0);
});

test("overload errors are retried, then the answer is used", async () => {
  const fetch = fakeFetch([jsonResponse({ error: { message: "overloaded" } }, 503), answer({ meals: [] })]);
  const gemini = createGemini({ apiKey: "k", model: "m", preferences: PREFERENCES, fetchFn: fetch.fn, sleep: noSleep });
  assert.deepEqual(await gemini.plan([], [], 1, []), { meals: [] });
  assert.equal(fetch.calls.length, 2);
});

test("HTTP errors become German messages", async () => {
  const cases = [
    [400, "API key not valid. Please pass a valid API key.", /ungültig/],
    [404, "not found", /Modell "m"/],
    [429, "quota", /Anfragelimit/],
  ];
  for (const [status, message, expected] of cases) {
    const responses = Array.from({ length: 3 }, () => jsonResponse({ error: { message } }, status));
    const gemini = createGemini({
      apiKey: "k",
      model: "m",
      preferences: PREFERENCES,
      fetchFn: fakeFetch(responses).fn,
      sleep: noSleep,
    });
    await assert.rejects(gemini.plan([], [], 1, []), expected);
  }
});

test("responseText rejects blocked and truncated answers", () => {
  assert.throws(() => responseText({ promptFeedback: { blockReason: "SAFETY" } }), /SAFETY/);
  assert.throws(() => responseText({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] }), /MAX_TOKENS/);
});

test("sanitizeMeal fixes field types and drops meals without a name", () => {
  assert.equal(sanitizeMeal({ name: " " }), null);
  assert.deepEqual(
    sanitizeMeal({
      name: "Suppe",
      technique: "molecular",
      rich_dairy: "yes",
      prep_minutes: "abc",
      difficulty: "extreme",
      steps: [1, "Kochen"],
    }),
    {
      name: "Suppe",
      cuisine: "",
      technique: null,
      rich_dairy: false,
      description: "",
    fridge_ingredients: [],
    staples: [],
    prep_minutes: null,
    difficulty: "medium",
    steps: ["Kochen"],
    },
  );
});

test("meal schema asks for cuisine, technique and the cream/cheese flag", () => {
  const meal = ANALYSIS_SCHEMA.properties.meals.items;
  assert.equal(meal.properties.technique.enum.length, Object.keys(TECHNIQUES).length);
  assert.equal(meal.properties.rich_dairy.type, "BOOLEAN");
  for (const field of ["cuisine", "technique", "rich_dairy"]) assert.ok(meal.required.includes(field));
  assert.deepEqual(PLAN_SCHEMA.properties.meals.items, meal);
});

test("prompts contain the creativity guidance and nested lists", () => {
  const analyze = buildAnalyzePrompt(PREFERENCES, 6, ["Gulasch"]);
  assert.match(analyze, /everything in a creamy sauce/);
  assert.match(analyze, /different cooking technique/);
  assert.match(analyze, /Consider dishes from several cuisines/);
  assert.match(analyze, /\n {2}- Gulasch\n/);
  assert.match(analyze, /\n {2}- onions\n/);
});

test("plan prompt names techniques and the cream/cheese dish already chosen", () => {
  const prompt = buildPlanPrompt(PREFERENCES, ["Eier"], [], 2, [], { usedTechniques: ["boil", "gratin"], richDairyUsed: true });
  assert.match(prompt, /already used in this round; do not use them: boil, gratin/);
  assert.match(prompt, /no further meal may be \(rich_dairy: false\)/);
  assert.doesNotMatch(buildPlanPrompt(PREFERENCES, ["Eier"], [], 2, []), /already used in this round/);
});

test("prompts contain household settings and the output language", () => {
  const analyze = buildAnalyzePrompt(PREFERENCES, 6, []);
  assert.match(analyze, /for 3 people/);
  assert.match(analyze, /kein Schwein/);
  assert.match(analyze, /in German/);
  assert.match(analyze, /- \(none\)/);
  assert.match(buildPlanPrompt(PREFERENCES, ["Eier"], [], 2, []), /- Eier/);
});

test("settings are sanitized and stored", () => {
  assert.deepEqual(sanitizeSettings({ servings: "99", mealCount: "x", model: " " }), {
    apiKey: "",
    model: "gemini-pro-latest",
    servings: 20,
    dietaryNotes: "",
    mealCount: 4,
  });
  const storage = new RamStorage();
  saveSettings({ apiKey: " abc ", servings: 2 }, storage);
  assert.equal(loadSettings(storage).apiKey, "abc");
  assert.equal(loadSettings(storage).servings, 2);
});

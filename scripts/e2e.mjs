// End-to-end check with real Gemini calls, using the same modules as the app.
// Usage: npm run e2e -- <photo.jpg> [<photo.jpg> ...]
// Reads GEMINI_API_KEY (and optionally GEMINI_MODEL) from .env in the repository root.
// The memory is kept in RAM, so the history on the phone is not affected.

import { readFileSync } from "node:fs";
import path from "node:path";

import { createGemini } from "../app/js/gemini.js";
import { Memory } from "../app/js/memory.js";
import { Planner } from "../app/js/planner.js";
import { DEFAULT_SETTINGS } from "../app/js/settings.js";
import { stapleLabel } from "../app/js/staples.js";

const MIME_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function readEnv(file) {
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

class RamStorage {
  items = new Map();
  getItem(key) {
    return this.items.get(key) ?? null;
  }
  setItem(key, value) {
    this.items.set(key, String(value));
  }
}

const photoPaths = process.argv.slice(2);
if (photoPaths.length === 0) {
  console.error("Usage: npm run e2e -- <photo.jpg> [<photo.jpg> ...]");
  process.exit(1);
}

const env = readEnv(new URL("../.env", import.meta.url));
const model = env.GEMINI_MODEL || DEFAULT_SETTINGS.model;
const oracle = createGemini({
  apiKey: env.GEMINI_API_KEY,
  model,
  preferences: { servings: DEFAULT_SETTINGS.servings, dietaryNotes: "" },
});
const planner = new Planner({ oracle, memory: new Memory(new RamStorage()), mealCount: DEFAULT_SETTINGS.mealCount });

const photos = photoPaths.map((file) => ({
  data: readFileSync(file).toString("base64"),
  mimeType: MIME_TYPES[path.extname(file).toLowerCase()] ?? "image/jpeg",
}));

function printMeals(meals) {
  for (const meal of meals) {
    const staples = meal.staples.map(stapleLabel).join(", ") || "-";
    console.log(`  - ${meal.name} (${meal.prep_minutes} min, ${meal.difficulty}) | Vorrat: ${staples}`);
    console.log(`      ${meal.description}`);
  }
}

let start = performance.now();
const analysis = await planner.analyze(photos);
console.log(`Model: ${model}\nANALYZE in ${((performance.now() - start) / 1000).toFixed(1)}s`);
console.log(`\nINGREDIENTS (${analysis.ingredients.length}):`);
for (const item of analysis.ingredients) console.log(`  - ${item.name} (${item.quantity})`);
console.log("\nDRAFTS:");
for (const meal of analysis.draftMeals) {
  console.log(`  - ${meal.name} | Kühlschrank: ${meal.fridge_ingredients.join(", ")} | Vorrat: ${meal.staples}`);
}
const questions = analysis.staplesToAsk.map((question) => question.staple);
console.log(`\nSTAPLE QUESTIONS: ${questions.map(stapleLabel).join(", ") || "-"}`);

// Simulated user: has every staple except potatoes
const request = {
  ingredients: analysis.ingredients.map((item) => item.name),
  draftMeals: analysis.draftMeals,
  availableStaples: questions.filter((staple) => staple !== "potatoes"),
  missingStaples: questions.filter((staple) => staple === "potatoes"),
};
start = performance.now();
const first = await planner.suggest(request);
console.log(`\nSUGGEST in ${((performance.now() - start) / 1000).toFixed(1)}s`);
printMeals(first);

start = performance.now();
const second = await planner.suggest({ ...request, draftMeals: [] });
console.log(`\nOTHER IDEAS in ${((performance.now() - start) / 1000).toFixed(1)}s`);
printMeals(second);

console.log(`\nSTEPS of "${first[0]?.name}":`);
(first[0]?.steps ?? []).forEach((step, index) => console.log(`  ${index + 1}. ${step}`));

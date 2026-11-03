import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SETTINGS, MODEL_OPTIONS, loadSettings, sanitizeSettings, saveSettings } from "../app/js/settings.js";
import { RamStorage } from "./helpers.js";

test("missing or empty models fall back to the default model", () => {
  assert.equal(sanitizeSettings(null).model, DEFAULT_SETTINGS.model);
  assert.equal(sanitizeSettings({ model: "  " }).model, DEFAULT_SETTINGS.model);
  assert.equal(sanitizeSettings({ model: " gemini-3.1-pro-preview " }).model, "gemini-3.1-pro-preview");
});

test("a saved retired model is replaced by its successor", () => {
  const storage = new RamStorage();
  storage.setItem("fridge-oracle:settings", JSON.stringify({ apiKey: "key", model: "gemini-2.5-flash" }));

  assert.equal(loadSettings(storage).model, "gemini-3.5-flash-lite");
  assert.equal(saveSettings({ model: "gemini-2.5-flash" }, storage).model, "gemini-3.5-flash-lite");
});

test("the model options contain no retired model", () => {
  assert.ok(!MODEL_OPTIONS.includes("gemini-2.5-flash"));
  assert.ok(MODEL_OPTIONS.includes(DEFAULT_SETTINGS.model));
});

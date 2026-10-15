// UI of the app. All user-facing text is German; code and comments are English.

import { createGemini } from "./gemini.js";
import { Memory } from "./memory.js";
import { preparePhoto } from "./photos.js";
import { Planner } from "./planner.js";
import { MODEL_OPTIONS, loadSettings, saveSettings } from "./settings.js";
import { stapleLabel } from "./staples.js";

const MAX_PHOTOS = 4;
const DIFFICULTY_LABELS = { easy: "einfach", medium: "mittel", hard: "anspruchsvoll" };
const KIND_LABELS = { cooked: "gekocht", rejected: "abgelehnt" };

const memory = new Memory();
let settings = loadSettings();

const state = {
  photos: [], // [{data, mimeType, previewUrl}]
  ingredients: [], // [{name, quantity}]
  drafts: [], // draft meals from the photo analysis
  ingredientsAdded: false,
  staples: { available: [], missing: [] },
};

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function setStatus(text, { error = false, busy = false } = {}) {
  const status = $("status");
  status.textContent = text;
  status.classList.toggle("error", error);
  status.classList.toggle("busy", busy);
}

function createPlanner() {
  const oracle = createGemini({
    apiKey: settings.apiKey,
    model: settings.model,
    preferences: { servings: settings.servings, dietaryNotes: settings.dietaryNotes },
  });
  return new Planner({ oracle, memory, mealCount: settings.mealCount });
}

async function withBusy(buttons, message, action) {
  buttons.forEach((button) => (button.disabled = true));
  setStatus(message, { busy: true });
  try {
    await action();
    setStatus("");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Unbekannter Fehler.", { error: true });
  } finally {
    buttons.forEach((button) => (button.disabled = false));
    $("analyze-btn").disabled = state.photos.length === 0;
  }
}

// ---------- Settings ----------

function openSettings() {
  $("set-api-key").value = settings.apiKey;
  $("set-model").value = settings.model;
  $("set-servings").value = settings.servings;
  $("set-notes").value = settings.dietaryNotes;
  $("set-meal-count").value = settings.mealCount;
  $("settings-cancel").hidden = !settings.apiKey;
  $("settings").hidden = false;
  $("settings").scrollIntoView({ behavior: "smooth" });
}

$("model-options").replaceChildren(...MODEL_OPTIONS.map((model) => el("option", { value: model })));
$("settings-btn").addEventListener("click", openSettings);
$("settings-cancel").addEventListener("click", () => ($("settings").hidden = true));
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  settings = saveSettings({
    apiKey: $("set-api-key").value,
    model: $("set-model").value,
    servings: $("set-servings").value,
    dietaryNotes: $("set-notes").value,
    mealCount: $("set-meal-count").value,
  });
  $("settings").hidden = true;
  setStatus("Einstellungen gespeichert.");
});

// ---------- Step 1: photos ----------

function renderPreviews() {
  $("previews").replaceChildren(
    ...state.photos.map((photo, index) =>
      el("div", { className: "preview" }, [
        el("img", { src: photo.previewUrl, alt: `Foto ${index + 1}` }),
        el("button", {
          type: "button",
          textContent: "×",
          title: "Foto entfernen",
          onclick: () => {
            URL.revokeObjectURL(photo.previewUrl);
            state.photos.splice(index, 1);
            renderPreviews();
          },
        }),
      ]),
    ),
  );
  $("analyze-btn").disabled = state.photos.length === 0;
}

async function addPhotos(event) {
  const free = MAX_PHOTOS - state.photos.length;
  const files = [...event.target.files].slice(0, free);
  event.target.value = "";
  if (files.length === 0 && free === 0) {
    setStatus(`Höchstens ${MAX_PHOTOS} Fotos.`, { error: true });
    return;
  }
  setStatus("Fotos werden vorbereitet.", { busy: true });
  try {
    for (const file of files) state.photos.push(await preparePhoto(file));
    setStatus("");
  } catch (error) {
    setStatus(`Foto konnte nicht gelesen werden: ${error.message}`, { error: true });
  }
  renderPreviews();
}

$("camera-input").addEventListener("change", addPhotos);
$("gallery-input").addEventListener("change", addPhotos);

$("analyze-btn").addEventListener("click", () => {
  if (!settings.apiKey) {
    openSettings();
    setStatus("Bitte zuerst den API-Schlüssel eintragen.", { error: true });
    return;
  }
  withBusy([$("analyze-btn")], "Die Fotos werden analysiert. Das dauert etwa eine Minute.", async () => {
    const result = await createPlanner().analyze(state.photos);
    state.ingredients = result.ingredients;
    state.drafts = result.draftMeals;
    state.ingredientsAdded = false;
    renderIngredients();
    renderStaples(result.staplesToAsk);
    $("step-review").hidden = false;
    $("step-results").hidden = true;
    $("step-review").scrollIntoView({ behavior: "smooth" });
  });
});

// ---------- Step 2: ingredients and staples ----------

function renderIngredients() {
  $("ingredients").replaceChildren(
    ...state.ingredients.map((item, index) =>
      el("li", {}, [
        el("span", { textContent: item.name }),
        el("span", { className: "qty", textContent: item.quantity }),
        el("button", {
          type: "button",
          textContent: "×",
          title: `${item.name} entfernen`,
          onclick: () => {
            state.ingredients.splice(index, 1);
            renderIngredients();
          },
        }),
      ]),
    ),
  );
}

function renderStaples(questions) {
  $("staples-block").hidden = questions.length === 0;
  $("staples").replaceChildren(
    ...questions.map((question) =>
      el("label", {}, [
        el("input", {
          type: "checkbox",
          value: question.staple,
          // Unknown staples are pre-checked: most households have them
          checked: question.lastKnown !== false,
        }),
        stapleLabel(question.staple),
      ]),
    ),
  );
}

$("add-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("add-input").value.trim();
  if (!name) return;
  state.ingredients.push({ name, quantity: "" });
  state.ingredientsAdded = true;
  $("add-input").value = "";
  renderIngredients();
});

function readStaples() {
  const boxes = [...$("staples").querySelectorAll("input[type=checkbox]")];
  return {
    available: boxes.filter((box) => box.checked).map((box) => box.value),
    missing: boxes.filter((box) => !box.checked).map((box) => box.value),
  };
}

async function requestMeals(draftMeals) {
  const meals = await createPlanner().suggest({
    ingredients: state.ingredients.map((item) => item.name),
    draftMeals,
    availableStaples: state.staples.available,
    missingStaples: state.staples.missing,
  });
  renderMeals(meals);
  $("step-results").hidden = false;
  $("step-results").scrollIntoView({ behavior: "smooth" });
}

$("suggest-btn").addEventListener("click", () =>
  withBusy([$("suggest-btn")], "Gerichte werden ausgewählt.", async () => {
    state.staples = readStaples();
    // Added ingredients are unknown to the drafts, so new meals are requested
    await requestMeals(state.ingredientsAdded ? [] : state.drafts);
  }),
);

// ---------- Step 3: meals ----------

function renderMeal(meal) {
  const card = el("article", { className: "meal" });
  const cookButton = el("button", { type: "button", className: "small", textContent: "Kochen wir" });
  const rejectButton = el("button", { type: "button", className: "small secondary", textContent: "Nicht für uns" });

  cookButton.onclick = () => {
    memory.record([meal.name], "cooked");
    cookButton.textContent = "Gespeichert";
    cookButton.disabled = rejectButton.disabled = true;
    renderHistory();
  };
  rejectButton.onclick = () => {
    memory.record([meal.name], "rejected");
    card.classList.add("rejected");
    cookButton.disabled = rejectButton.disabled = true;
    renderHistory();
  };

  const meta = [meal.prep_minutes ? `${meal.prep_minutes} Min.` : null, DIFFICULTY_LABELS[meal.difficulty]];
  const parts = [
    el("h3", { textContent: meal.name }),
    el("p", { textContent: meal.description }),
    el("p", { className: "meta", textContent: meta.filter(Boolean).join(", ") }),
    el("p", { textContent: `Aus dem Kühlschrank: ${meal.fridge_ingredients.join(", ") || "-"}` }),
  ];
  if (meal.staples.length > 0) {
    parts.push(el("p", { textContent: `Aus dem Vorrat: ${meal.staples.map(stapleLabel).join(", ")}` }));
  }
  parts.push(
    el("details", {}, [
      el("summary", { textContent: "Zubereitung" }),
      el("ol", {}, meal.steps.map((step) => el("li", { textContent: step }))),
    ]),
    el("div", { className: "row" }, [cookButton, rejectButton]),
  );
  card.append(...parts);
  return card;
}

function renderMeals(meals) {
  if (meals.length === 0) {
    $("meals").replaceChildren(
      el("p", { textContent: "Kein neues Gericht gefunden. Zutaten ergänzen oder mehr Vorräte erlauben." }),
    );
    return;
  }
  $("meals").replaceChildren(...meals.map(renderMeal));
}

$("more-btn").addEventListener("click", () =>
  withBusy([$("more-btn"), $("restart-btn")], "Andere Gerichte werden gesucht.", () => requestMeals([])),
);

$("restart-btn").addEventListener("click", () => {
  state.photos.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
  state.photos = [];
  renderPreviews();
  $("step-review").hidden = true;
  $("step-results").hidden = true;
  setStatus("");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ---------- History ----------

function renderHistory() {
  const entries = memory.history();
  if (entries.length === 0) {
    $("history").replaceChildren(el("li", { className: "meta", textContent: "Noch keine Einträge." }));
    return;
  }
  $("history").replaceChildren(
    ...entries.map((entry) =>
      el("li", {}, [
        el("div", {}, [
          el("div", { textContent: entry.name }),
          el("div", {
            className: "meta",
            textContent: `${KIND_LABELS[entry.kind]}, ${new Date(entry.createdAt).toLocaleDateString("de-DE")}`,
          }),
        ]),
        el("button", {
          type: "button",
          className: "small secondary",
          textContent: "Entfernen",
          title: "Aus dem Verlauf entfernen (das Gericht kann wieder vorgeschlagen werden)",
          onclick: () => {
            memory.deleteEvent(entry.id);
            renderHistory();
          },
        }),
      ]),
    ),
  );
}

// ---------- Start ----------

renderHistory();
if (!settings.apiKey) openSettings();

// Asks the browser not to evict the stored history when storage runs low
navigator.storage?.persist?.().catch(() => {});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((error) => console.warn("Service worker:", error));
}

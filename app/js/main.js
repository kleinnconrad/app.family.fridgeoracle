// UI of the app. All user-facing text is German; code and comments are English.
//
// The current run lives in `session` and is saved to IndexedDB after every change,
// so that a reload restores it. Every render function draws from `session`.

import { TECHNIQUES, createGemini } from "./gemini.js";
import { Memory } from "./memory.js";
import { preparePhoto } from "./photos.js";
import { Planner } from "./planner.js";
import { createSessionStore, emptySession } from "./session.js";
import { MODEL_OPTIONS, loadSettings, saveSettings } from "./settings.js";
import { stapleLabel } from "./staples.js";

const MAX_PHOTOS = 4;
const RESET_HOLD_MS = 1500;
const SCROLL_KEY = "fridge-oracle:scroll";
const DIFFICULTY_LABELS = { easy: "einfach", medium: "mittel", hard: "anspruchsvoll" };
const KIND_LABELS = { cooked: "gekocht", rejected: "abgelehnt" };

const memory = new Memory();
const sessionStore = createSessionStore();
let settings = loadSettings();
let session = emptySession();
// Incremented on reset; answers of requests started before a reset are discarded
let runId = 0;

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

// ---------- Persistence ----------

function saveState() {
  sessionStore.saveState(session).catch((error) => console.warn("Saving the run failed:", error));
}

function savePhotos() {
  sessionStore.savePhotos(session.photos).catch((error) => console.warn("Saving the photos failed:", error));
}

function photoUrl(photo) {
  return `data:${photo.mimeType};base64,${photo.data}`;
}

/**
 * Runs a Gemini request with busy indicator. The pending flag is saved, so that a reload
 * during the request can tell the user to start it again.
 */
async function runRequest(kind, buttons, message, request, apply) {
  const startedRun = runId;
  buttons.forEach((button) => (button.disabled = true));
  setStatus(message, { busy: true });
  session.pending = kind;
  saveState();
  try {
    const result = await request();
    if (startedRun !== runId) return;
    apply(result);
    setStatus("");
  } catch (error) {
    if (startedRun !== runId) return;
    console.error(error);
    setStatus(error.message || "Unbekannter Fehler.", { error: true });
  } finally {
    if (startedRun === runId) {
      session.pending = null;
      saveState();
      buttons.forEach((button) => (button.disabled = false));
      renderAll();
    }
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
    ...session.photos.map((photo, index) =>
      el("div", { className: "preview" }, [
        el("img", { src: photoUrl(photo), alt: `Foto ${index + 1}` }),
        el("button", {
          type: "button",
          textContent: "×",
          title: "Foto entfernen",
          onclick: () => {
            session.photos.splice(index, 1);
            savePhotos();
            renderAll();
          },
        }),
      ]),
    ),
  );
  $("analyze-btn").disabled = session.photos.length === 0 || session.pending !== null;
}

async function addPhotos(event) {
  const free = MAX_PHOTOS - session.photos.length;
  const files = [...event.target.files].slice(0, free);
  event.target.value = "";
  if (files.length === 0 && free === 0) {
    setStatus(`Höchstens ${MAX_PHOTOS} Fotos.`, { error: true });
    return;
  }
  setStatus("Fotos werden vorbereitet.", { busy: true });
  try {
    for (const file of files) session.photos.push(await preparePhoto(file));
    setStatus("");
  } catch (error) {
    setStatus(`Foto konnte nicht gelesen werden: ${error.message}`, { error: true });
  }
  savePhotos();
  renderAll();
}

$("camera-input").addEventListener("change", addPhotos);
$("gallery-input").addEventListener("change", addPhotos);

$("analyze-btn").addEventListener("click", () => {
  if (!settings.apiKey) {
    openSettings();
    setStatus("Bitte zuerst den API-Schlüssel eintragen.", { error: true });
    return;
  }
  runRequest(
    "analyze",
    [$("analyze-btn")],
    "Die Fotos werden analysiert. Das dauert etwa eine Minute.",
    () => createPlanner().analyze(session.photos),
    (result) => {
      Object.assign(session, {
        analyzed: true,
        ingredients: result.ingredients,
        drafts: result.draftMeals,
        ingredientsAdded: false,
        questions: result.staplesToAsk,
        answers: Object.fromEntries(result.staplesToAsk.map((q) => [q.staple, q.lastKnown !== false])),
        meals: null,
        feedback: {},
      });
      renderAll();
      $("step-review").scrollIntoView({ behavior: "smooth" });
    },
  );
});

// ---------- Step 2: ingredients and staples ----------

function renderIngredients() {
  $("ingredients").replaceChildren(
    ...session.ingredients.map((item, index) =>
      el("li", {}, [
        el("span", { textContent: item.name }),
        el("span", { className: "qty", textContent: item.quantity }),
        el("button", {
          type: "button",
          textContent: "×",
          title: `${item.name} entfernen`,
          onclick: () => {
            session.ingredients.splice(index, 1);
            saveState();
            renderIngredients();
          },
        }),
      ]),
    ),
  );
}

function renderStaples() {
  $("staples-block").hidden = session.questions.length === 0;
  $("staples").replaceChildren(
    ...session.questions.map((question) =>
      el("label", {}, [
        el("input", {
          type: "checkbox",
          value: question.staple,
          // Unknown staples are pre-checked: most households have them
          checked: session.answers[question.staple] ?? question.lastKnown !== false,
          onchange: (event) => {
            session.answers[question.staple] = event.target.checked;
            saveState();
          },
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
  session.ingredients.push({ name, quantity: "" });
  session.ingredientsAdded = true;
  $("add-input").value = "";
  saveState();
  renderIngredients();
});

function currentAnswers() {
  const staples = session.questions.map((question) => question.staple);
  const checked = (staple) => session.answers[staple] ?? true;
  return {
    available: staples.filter(checked),
    missing: staples.filter((staple) => !checked(staple)),
  };
}

function requestMeals(kind, buttons, message, draftMeals) {
  runRequest(
    kind,
    buttons,
    message,
    () =>
      createPlanner().suggest({
        ingredients: session.ingredients.map((item) => item.name),
        draftMeals,
        availableStaples: session.staples.available,
        missingStaples: session.staples.missing,
      }),
    (meals) => {
      session.meals = meals;
      session.feedback = {};
      renderAll();
      $("step-results").scrollIntoView({ behavior: "smooth" });
    },
  );
}

$("suggest-btn").addEventListener("click", () => {
  session.staples = currentAnswers();
  // Added ingredients are unknown to the drafts, so new meals are requested
  const drafts = session.ingredientsAdded ? [] : session.drafts;
  requestMeals("suggest", [$("suggest-btn")], "Gerichte werden ausgewählt.", drafts);
});

// ---------- Step 3: meals ----------

function giveFeedback(meal, kind) {
  memory.record([meal.name], kind);
  session.feedback[meal.name] = kind;
  saveState();
  renderMeals();
  renderHistory();
}

function renderMeal(meal) {
  const feedback = session.feedback[meal.name];
  const cookButton = el("button", {
    type: "button",
    className: "small",
    textContent: feedback === "cooked" ? "Gespeichert" : "Kochen wir",
    disabled: Boolean(feedback),
    onclick: () => giveFeedback(meal, "cooked"),
  });
  const rejectButton = el("button", {
    type: "button",
    className: "small secondary",
    textContent: "Nicht für uns",
    disabled: Boolean(feedback),
    onclick: () => giveFeedback(meal, "rejected"),
  });

  const meta = [
    meal.cuisine || null,
    TECHNIQUES[meal.technique] ?? null,
    meal.prep_minutes ? `${meal.prep_minutes} Min.` : null,
    DIFFICULTY_LABELS[meal.difficulty],
  ];
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
  return el("article", { className: feedback === "rejected" ? "meal rejected" : "meal" }, parts);
}

function renderMeals() {
  const meals = session.meals ?? [];
  if (meals.length === 0) {
    $("meals").replaceChildren(
      el("p", { textContent: "Kein neues Gericht gefunden. Zutaten ergänzen oder mehr Vorräte erlauben." }),
    );
    return;
  }
  $("meals").replaceChildren(...meals.map(renderMeal));
}

$("more-btn").addEventListener("click", () =>
  requestMeals("suggest", [$("more-btn")], "Andere Gerichte werden gesucht.", []),
);

// ---------- Reset (press and hold) ----------

function resetRun() {
  runId++;
  session = emptySession();
  // A request cancelled by the reset does not re-enable its buttons
  for (const id of ["analyze-btn", "suggest-btn", "more-btn"]) $(id).disabled = false;
  sessionStore.clear().catch((error) => console.warn("Clearing the run failed:", error));
  $("add-input").value = "";
  setStatus("");
  renderAll();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/** Calls onConfirm only after the button was held for durationMs; a short tap shows a hint. */
function setupHoldButton(button, durationMs, hint, onConfirm) {
  let timer = null;
  let confirmed = false;
  button.style.setProperty("--hold-duration", `${durationMs}ms`);

  const start = (event) => {
    if (timer) return;
    if (event.type === "pointerdown" && event.button !== 0) return;
    if (event.type === "keydown") {
      if ((event.key !== "Enter" && event.key !== " ") || event.repeat) return;
      event.preventDefault();
    }
    button.classList.add("holding");
    timer = setTimeout(() => {
      timer = null;
      confirmed = true;
      button.classList.remove("holding");
      navigator.vibrate?.(40);
      onConfirm();
    }, durationMs);
  };
  const cancel = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    button.classList.remove("holding");
  };

  button.addEventListener("pointerdown", start);
  button.addEventListener("keydown", start);
  // Lifting the finger, moving away or starting to scroll cancels the hold
  for (const type of ["pointerup", "pointerleave", "pointercancel", "keyup", "blur"]) {
    button.addEventListener(type, cancel);
  }
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    if (!confirmed) setStatus(hint);
    confirmed = false;
  });
}

setupHoldButton($("reset-btn"), RESET_HOLD_MS, "Zum Neustart die Taste gedrückt halten.", resetRun);

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

// ---------- Rendering ----------

function renderAll() {
  renderPreviews();
  $("step-review").hidden = !session.analyzed;
  if (session.analyzed) {
    renderIngredients();
    renderStaples();
  }
  $("step-results").hidden = session.meals === null;
  if (session.meals !== null) renderMeals();
  $("reset-bar").hidden = session.photos.length === 0 && !session.analyzed;
}

// ---------- Start ----------

async function start() {
  renderHistory();
  try {
    const restored = await sessionStore.load();
    if (restored) session = restored;
  } catch (error) {
    console.warn("Restoring the run failed:", error);
  }
  const interrupted = session.pending !== null;
  session.pending = null;
  renderAll();

  if (interrupted) {
    saveState();
    setStatus("Die letzte Anfrage wurde durch das Neuladen unterbrochen. Bitte erneut starten.", { error: true });
  }
  const scroll = Number(sessionStorage.getItem(SCROLL_KEY));
  if (scroll > 0) window.scrollTo(0, scroll);
  if (!settings.apiKey) openSettings();
}

// The content is restored asynchronously, so the scroll position is restored by hand
history.scrollRestoration = "manual";
window.addEventListener("pagehide", () => sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)));

start();

// Asks the browser not to evict the stored history when storage runs low
navigator.storage?.persist?.().catch(() => {});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((error) => console.warn("Service worker:", error));
}

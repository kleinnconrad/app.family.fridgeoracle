// The current run (photos, ingredients, answers, meals), saved in IndexedDB so that it
// survives a page reload. localStorage is too small for the photos (several MB each).
// Photos and the rest of the state are stored under separate keys, so that a checkbox
// change does not rewrite the photos.

import { sanitizeMeal } from "./gemini.js";
import { STAPLE_KEYS } from "./staples.js";

export const SESSION_VERSION = 1;
const DB_NAME = "fridge-oracle";
const STORE = "session";
const FEEDBACK_KINDS = ["cooked", "rejected"];
const PENDING_KINDS = ["analyze", "suggest"];

/** Returns the initial state of a run. */
export function emptySession() {
  return {
    photos: [], // [{data, mimeType}] base64-encoded
    analyzed: false,
    ingredients: [], // [{name, quantity}]
    drafts: [], // draft meals from the photo analysis
    ingredientsAdded: false,
    questions: [], // [{staple, lastKnown}] staple questions from the analysis
    answers: {}, // staple -> checked, current state of the checkboxes
    staples: { available: [], missing: [] }, // answers used for the last suggestion
    meals: null, // shown meals, or null before the first suggestion
    feedback: {}, // meal name -> "cooked" | "rejected"
    pending: null, // "analyze" | "suggest" while a Gemini request runs
  };
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const array = (value) => (Array.isArray(value) ? value : []);
const knownStaples = (value) => array(value).filter((staple) => STAPLE_KEYS.includes(staple));

/**
 * Validates a stored run. Returns null if the data is unusable or from another version.
 * @param {unknown} raw Stored state, with the photos merged in.
 */
export function sanitizeSession(raw) {
  if (!isObject(raw) || raw.version !== SESSION_VERSION) return null;
  const session = emptySession();
  session.photos = array(raw.photos)
    .filter((photo) => isObject(photo) && typeof photo.data === "string" && typeof photo.mimeType === "string")
    .map(({ data, mimeType }) => ({ data, mimeType }));
  session.analyzed = raw.analyzed === true;
  session.ingredients = array(raw.ingredients)
    .filter((item) => isObject(item) && typeof item.name === "string" && item.name.trim())
    .map((item) => ({ name: item.name, quantity: typeof item.quantity === "string" ? item.quantity : "" }));
  session.drafts = array(raw.drafts).map(sanitizeMeal).filter(Boolean);
  session.ingredientsAdded = raw.ingredientsAdded === true;
  session.questions = array(raw.questions)
    .filter((question) => isObject(question) && STAPLE_KEYS.includes(question.staple))
    .map((question) => ({
      staple: question.staple,
      lastKnown: typeof question.lastKnown === "boolean" ? question.lastKnown : null,
    }));
  for (const [staple, checked] of Object.entries(isObject(raw.answers) ? raw.answers : {})) {
    if (STAPLE_KEYS.includes(staple) && typeof checked === "boolean") session.answers[staple] = checked;
  }
  if (isObject(raw.staples)) {
    session.staples = { available: knownStaples(raw.staples.available), missing: knownStaples(raw.staples.missing) };
  }
  session.meals = Array.isArray(raw.meals) ? raw.meals.map(sanitizeMeal).filter(Boolean) : null;
  for (const [name, kind] of Object.entries(isObject(raw.feedback) ? raw.feedback : {})) {
    if (FEEDBACK_KINDS.includes(kind)) session.feedback[name] = kind;
  }
  session.pending = PENDING_KINDS.includes(raw.pending) ? raw.pending : null;
  return session;
}

/** Returns the state without photos, ready to be stored. */
export function serializeState(session) {
  const { photos, ...rest } = session;
  return { version: SESSION_VERSION, ...structuredClone(rest) };
}

/**
 * Creates the IndexedDB-backed store for the current run.
 * @param {IDBFactory} factory indexedDB; replaceable in tests.
 */
export function createSessionStore(factory = globalThis.indexedDB) {
  let database = null;

  function open() {
    database ??= new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }

  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    /** Returns the stored run, or null if there is none or it is unusable. */
    async load() {
      const [state, photos] = await Promise.all([
        transaction("readonly", (store) => store.get("state")),
        transaction("readonly", (store) => store.get("photos")),
      ]);
      if (!state && !photos) return null;
      // Photos taken before the first analysis are stored without a state
      return sanitizeSession({ ...(state ?? serializeState(emptySession())), photos });
    },
    saveState(session) {
      const state = serializeState(session);
      return transaction("readwrite", (store) => store.put(state, "state"));
    },
    savePhotos(photos) {
      const plain = photos.map(({ data, mimeType }) => ({ data, mimeType }));
      return transaction("readwrite", (store) => store.put(plain, "photos"));
    },
    clear() {
      return transaction("readwrite", (store) => store.clear());
    },
  };
}

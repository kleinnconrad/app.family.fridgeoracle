// Persistent memory on the phone: meal history (to avoid repeated suggestions) and pantry answers.
// Stored as one JSON document in localStorage (or any object with getItem/setItem).

import { normalize } from "./planner.js";
import { STAPLE_KEYS } from "./staples.js";

export const SUGGESTION_COOLDOWN_DAYS = 3;
export const COOKED_COOLDOWN_DAYS = 14;
// Upper limit of meal names passed to the model as "do not suggest", to keep the prompt short.
export const MAX_EXCLUDED_NAMES = 80;
// Upper limit of stored cooked/rejected events.
export const MAX_HISTORY_EVENTS = 500;

const STORAGE_KEY = "fridge-oracle:memory";
const DAY_MS = 24 * 60 * 60 * 1000;
export const EVENT_KINDS = ["suggested", "cooked", "rejected"];

function emptyData() {
  return { nextId: 1, events: [], pantry: {} };
}

export class Memory {
  /**
   * @param {Storage} storage localStorage or a compatible object.
   * @param {() => Date} clock Returns the current time; replaceable in tests.
   */
  constructor(storage = globalThis.localStorage, clock = () => new Date()) {
    this.storage = storage;
    this.clock = clock;
  }

  load() {
    try {
      const data = JSON.parse(this.storage.getItem(STORAGE_KEY));
      if (data && Array.isArray(data.events) && typeof data.pantry === "object") return data;
    } catch {
      // Corrupt or unreadable data; start empty
    }
    return emptyData();
  }

  save(data) {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  /** Returns the events that still matter: suggestions within the cooldown and all cooked/rejected. */
  prune(events) {
    const suggestionCutoff = this.clock().getTime() - SUGGESTION_COOLDOWN_DAYS * DAY_MS;
    const suggested = events.filter(
      (event) => event.kind === "suggested" && Date.parse(event.createdAt) >= suggestionCutoff,
    );
    const history = events.filter((event) => event.kind !== "suggested").slice(-MAX_HISTORY_EVENTS);
    return [...suggested, ...history].sort((a, b) => a.id - b.id);
  }

  /** Stores one event per meal name. */
  record(names, kind) {
    if (!EVENT_KINDS.includes(kind)) throw new Error(`Unknown event kind: ${kind}`);
    const data = this.load();
    const createdAt = this.clock().toISOString();
    for (const name of names) {
      const trimmed = String(name).trim();
      if (!trimmed) continue;
      data.events.push({ id: data.nextId++, name: trimmed, normalized: normalize(trimmed), kind, createdAt });
    }
    data.events = this.prune(data.events);
    this.save(data);
  }

  /**
   * Returns the meals that must not be suggested now, most recent first: rejected meals
   * (permanently), meals cooked within the cooked cooldown and meals suggested within the
   * suggestion cooldown. One name per normalized name, at most MAX_EXCLUDED_NAMES.
   */
  excludedNames() {
    const now = this.clock().getTime();
    const cutoffs = {
      rejected: -Infinity,
      cooked: now - COOKED_COOLDOWN_DAYS * DAY_MS,
      suggested: now - SUGGESTION_COOLDOWN_DAYS * DAY_MS,
    };
    const names = new Map();
    for (const event of [...this.load().events].reverse()) {
      if (Date.parse(event.createdAt) < cutoffs[event.kind]) continue;
      if (!names.has(event.normalized)) names.set(event.normalized, event.name);
    }
    return [...names.values()].slice(0, MAX_EXCLUDED_NAMES);
  }

  /** Returns the cooked and rejected meals, most recent first. */
  history(limit = 50) {
    return this.load()
      .events.filter((event) => event.kind !== "suggested")
      .reverse()
      .slice(0, limit);
  }

  /** Deletes one event, e.g. to undo a rejection. Returns true if an event was deleted. */
  deleteEvent(id) {
    const data = this.load();
    const before = data.events.length;
    data.events = data.events.filter((event) => event.id !== id);
    this.save(data);
    return data.events.length < before;
  }

  /** Returns the last answer per staple; staples never asked about are missing. */
  pantry() {
    const result = {};
    for (const [staple, entry] of Object.entries(this.load().pantry)) {
      if (STAPLE_KEYS.includes(staple)) result[staple] = entry.available;
    }
    return result;
  }

  /** Stores the user's answers about staples. */
  updatePantry(available, missing) {
    const data = this.load();
    const updatedAt = this.clock().toISOString();
    for (const staple of available) data.pantry[staple] = { available: true, updatedAt };
    for (const staple of missing) data.pantry[staple] = { available: false, updatedAt };
    this.save(data);
  }
}

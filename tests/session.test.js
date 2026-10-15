import assert from "node:assert/strict";
import { test } from "node:test";

import { SESSION_VERSION, emptySession, sanitizeSession, serializeState } from "../app/js/session.js";
import { makeMeal } from "./helpers.js";

function fullSession() {
  return {
    ...emptySession(),
    photos: [{ data: "AAAA", mimeType: "image/jpeg" }],
    analyzed: true,
    ingredients: [{ name: "Eier", quantity: "6" }],
    drafts: [makeMeal("Rührei")],
    ingredientsAdded: true,
    questions: [{ staple: "onions", lastKnown: false }],
    answers: { onions: true },
    staples: { available: ["onions"], missing: ["potatoes"] },
    meals: [makeMeal("Omelett", ["Eier"], ["onions"])],
    feedback: { Omelett: "cooked" },
    pending: "suggest",
  };
}

test("a stored run survives serialization unchanged", () => {
  const session = fullSession();
  const stored = serializeState(session);
  assert.equal(stored.version, SESSION_VERSION);
  assert.equal(stored.photos, undefined, "photos are stored separately");
  assert.deepEqual(sanitizeSession({ ...stored, photos: session.photos }), session);
});

test("meals are null before the first suggestion and an empty list after an empty result", () => {
  const base = serializeState(emptySession());
  assert.equal(sanitizeSession(base).meals, null);
  assert.deepEqual(sanitizeSession({ ...base, meals: [] }).meals, []);
});

test("unusable data is rejected or cleaned", () => {
  assert.equal(sanitizeSession(null), null);
  assert.equal(sanitizeSession("text"), null);
  assert.equal(sanitizeSession({ ...serializeState(fullSession()), version: 99 }), null);

  const cleaned = sanitizeSession({
    version: SESSION_VERSION,
    photos: [{ data: 1 }, { data: "BBBB", mimeType: "image/png", extra: true }],
    ingredients: [{ name: "" }, { name: "Milch" }, "Käse"],
    drafts: [{ name: "" }, makeMeal("Toast")],
    questions: [{ staple: "caviar" }, { staple: "rice", lastKnown: "yes" }],
    answers: { rice: true, caviar: true, onions: "no" },
    staples: { available: ["rice", "caviar"], missing: "onions" },
    meals: "none",
    feedback: { Toast: "liked", Suppe: "rejected" },
    pending: "upload",
  });
  assert.deepEqual(cleaned.photos, [{ data: "BBBB", mimeType: "image/png" }]);
  assert.deepEqual(cleaned.ingredients, [{ name: "Milch", quantity: "" }]);
  assert.deepEqual(
    cleaned.drafts.map((meal) => meal.name),
    ["Toast"],
  );
  assert.deepEqual(cleaned.questions, [{ staple: "rice", lastKnown: null }]);
  assert.deepEqual(cleaned.answers, { rice: true });
  assert.deepEqual(cleaned.staples, { available: ["rice"], missing: [] });
  assert.equal(cleaned.meals, null);
  assert.deepEqual(cleaned.feedback, { Suppe: "rejected" });
  assert.equal(cleaned.pending, null);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { Memory } from "../app/js/memory.js";
import { Planner, normalize, pickVaried, staplesToAsk, usableMeals } from "../app/js/planner.js";
import { FakeOracle, RamStorage, fridgeAnalysis, makeMeal } from "./helpers.js";

const PHOTO = { data: "anBlZw==", mimeType: "image/jpeg" };

function makePlanner(oracle, mealCount = 2) {
  const memory = new Memory(new RamStorage());
  return { planner: new Planner({ oracle, memory, mealCount }), memory };
}

test("normalize ignores case and punctuation, keeps umlauts", () => {
  assert.equal(normalize("  Spätzle   mit Käse! "), "spätzle mit käse");
  assert.equal(normalize("Chili-con-Carne"), "chili con carne");
});

test("staplesToAsk lists each needed staple once with the previous answer", () => {
  const meals = [makeMeal("A", [], ["potatoes", "onions"]), makeMeal("B", [], ["onions"]), makeMeal("C")];
  assert.deepEqual(staplesToAsk(meals, { onions: false }), [
    { staple: "onions", lastKnown: false },
    { staple: "potatoes", lastKnown: null },
  ]);
});

test("usableMeals filters by staples, ingredients and history", () => {
  const meals = [
    makeMeal("Omelett", ["Eier"], ["onions"]),
    makeMeal("Reispfanne", ["Eier"], ["rice"]),
    makeMeal("Spinatkuchen", ["Spinat"]),
    makeMeal("Spiegelei", ["Ei", "Salz"]),
    makeMeal("spiegelei!", ["Eier"]),
    makeMeal("Pfannkuchen", ["Eier"]),
    makeMeal("Zwiebelkuchen", ["Eier", "Zwiebeln"], ["onions"]),
  ];
  const result = usableMeals(meals, ["Eier", "Milch"], ["onions"], ["Pfannkuchen"]);
  // Rice is missing, spinach was removed, the duplicate and the excluded meal are dropped.
  // German staple labels in fridge_ingredients ("Zwiebeln") are accepted.
  assert.deepEqual(
    result.map((meal) => meal.name),
    ["Omelett", "Spiegelei", "Zwiebelkuchen"],
  );
});

test("analyze drops excluded drafts and asks only for their staples", async () => {
  const oracle = new FakeOracle({ analysis: fridgeAnalysis() });
  const { planner, memory } = makePlanner(oracle);
  memory.record(["Käse-Kartoffeln"], "cooked");

  const result = await planner.analyze([PHOTO]);

  assert.equal(oracle.analyzeCalls[0].mealCount, 5);
  assert.deepEqual(oracle.analyzeCalls[0].excluded, ["Käse-Kartoffeln"]);
  assert.deepEqual(
    result.draftMeals.map((meal) => meal.name),
    ["Spinat-Omelett", "Rührei"],
  );
  assert.deepEqual(
    result.staplesToAsk.map((question) => question.staple),
    ["onions"],
  );
});

test("suggest reuses drafts without a new call when enough remain", async () => {
  const oracle = new FakeOracle();
  const { planner, memory } = makePlanner(oracle);

  const meals = await planner.suggest({
    ingredients: ["Eier", "Gouda", "Spinat"],
    draftMeals: fridgeAnalysis().meals,
    availableStaples: ["onions"],
    missingStaples: ["potatoes"],
  });

  assert.deepEqual(
    meals.map((meal) => meal.name),
    ["Spinat-Omelett", "Rührei"],
  );
  assert.equal(oracle.planCalls.length, 0);
  assert.deepEqual(new Set(memory.excludedNames()), new Set(["Spinat-Omelett", "Rührei"]));
  assert.deepEqual(memory.pantry(), { onions: true, potatoes: false });
});

test("suggest fills up with a plan call and blocks already chosen meals", async () => {
  const oracle = new FakeOracle({
    plans: [{ meals: [makeMeal("rührei"), makeMeal("Käsetoast", ["Gouda"])] }],
  });
  const { planner } = makePlanner(oracle);

  const meals = await planner.suggest({
    ingredients: ["Eier", "Gouda"],
    draftMeals: fridgeAnalysis().meals,
    availableStaples: [],
    missingStaples: ["onions", "potatoes"],
  });

  // Only "Rührei" survives the filter; the plan call repeats it, so only "Käsetoast" is added
  assert.deepEqual(
    meals.map((meal) => meal.name),
    ["Rührei", "Käsetoast"],
  );
  assert.equal(oracle.planCalls[0].mealCount, 1);
  assert.deepEqual(oracle.planCalls[0].availableStaples, []);
  assert.ok(oracle.planCalls[0].excluded.includes("Rührei"));
});

test("suggest assumes staples confirmed in an earlier session", async () => {
  const oracle = new FakeOracle({ plans: [{ meals: [makeMeal("Gebratener Reis", ["Eier"], ["rice"])] }] });
  const { planner, memory } = makePlanner(oracle, 1);
  memory.updatePantry(["rice"], []);

  const meals = await planner.suggest({ ingredients: ["Eier"] });

  assert.deepEqual(
    meals.map((meal) => meal.name),
    ["Gebratener Reis"],
  );
  assert.deepEqual(oracle.planCalls[0].availableStaples, ["rice"]);
});

test("suggest stops after the maximum number of plan calls", async () => {
  const oracle = new FakeOracle();
  const { planner } = makePlanner(oracle, 3);
  const meals = await planner.suggest({ ingredients: ["Eier"] });
  assert.deepEqual(meals, []);
  assert.equal(oracle.planCalls.length, 2);
});

test("pickVaried allows each technique once and at most one cream or cheese dish", () => {
  const meals = [
    makeMeal("Sahnenudeln", ["Eier"], [], { technique: "boil", richDairy: true }),
    makeMeal("Käseauflauf", ["Eier"], [], { technique: "gratin", richDairy: true }),
    makeMeal("Spaghetti aglio e olio", ["Eier"], [], { technique: "boil" }),
    makeMeal("Shakshuka", ["Eier"], [], { technique: "braise" }),
    makeMeal("Unbekannt", ["Eier"]),
  ];
  assert.deepEqual(
    pickVaried(meals, 5).map((meal) => meal.name),
    ["Sahnenudeln", "Shakshuka", "Unbekannt"],
  );
  // Meals chosen earlier in the round count as well
  const earlier = [makeMeal("Omelett", ["Eier"], [], { technique: "braise", richDairy: true })];
  assert.deepEqual(
    pickVaried(meals, 5, earlier).map((meal) => meal.name),
    ["Spaghetti aglio e olio", "Unbekannt"],
  );
});

test("suggest asks for complementary meals and tells Gemini what is already used", async () => {
  const drafts = [
    makeMeal("Sahnenudeln", ["Eier"], [], { technique: "boil", richDairy: true }),
    makeMeal("Käseauflauf", ["Eier"], [], { technique: "gratin", richDairy: true }),
  ];
  const oracle = new FakeOracle({
    plans: [{ meals: [makeMeal("Bibimbap", ["Eier"], [], { technique: "stir-fry" })] }],
  });
  const { planner } = makePlanner(oracle, 2);

  const meals = await planner.suggest({ ingredients: ["Eier"], draftMeals: drafts });

  assert.deepEqual(
    meals.map((meal) => meal.name),
    ["Sahnenudeln", "Bibimbap"],
  );
  assert.deepEqual(oracle.planCalls[0].taken, { usedTechniques: ["boil"], richDairyUsed: true });
});

test("suggest falls back to skipped meals when Gemini cannot deliver enough varied ones", async () => {
  const drafts = [
    makeMeal("Sahnenudeln", ["Eier"], [], { technique: "boil", richDairy: true }),
    makeMeal("Käseauflauf", ["Eier"], [], { technique: "gratin", richDairy: true }),
  ];
  const oracle = new FakeOracle();
  const { planner } = makePlanner(oracle, 2);

  const meals = await planner.suggest({ ingredients: ["Eier"], draftMeals: drafts });

  assert.deepEqual(
    meals.map((meal) => meal.name),
    ["Sahnenudeln", "Käseauflauf"],
  );
  assert.equal(oracle.planCalls.length, 2);
});

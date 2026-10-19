// Combines Gemini, the memory and the user's answers into the final meal suggestions.
//
// Flow:
// 1. analyze: the photos are analyzed; Gemini returns the ingredients and draft meals.
//    The user is asked only about the staples these drafts need.
// 2. suggest: drafts that need a missing staple, use a removed ingredient or were
//    suggested recently are dropped. The remaining meals are picked for variety (each cooking
//    technique once, at most one cream or cheese dish). If too few remain, Gemini is asked
//    again (text only) with the confirmed ingredients, the available staples and the
//    techniques already used.

import { ALWAYS_AVAILABLE, ALWAYS_AVAILABLE_LABELS, STAPLES, STAPLE_KEYS } from "./staples.js";

// Extra drafts requested in the photo analysis, as a reserve for meals dropped later.
export const DRAFT_RESERVE = 3;
// Maximum text-only Gemini calls per suggest() to fill up the list.
export const MAX_PLAN_CALLS = 2;
// Maximum meals per round that are built around cream, cream cheese or melted cheese.
export const MAX_RICH_DAIRY = 1;

/** Returns a comparable form of a meal or ingredient name (lower case, no punctuation). */
export function normalize(name) {
  return String(name)
    .toLocaleLowerCase("de")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

// Containment instead of equality, so that "Ei" matches "Eier" and "Gouda" matches "Gouda-Scheiben"
function matchesAny(item, allowed) {
  for (const name of allowed) {
    if (item.includes(name) || name.includes(item)) return true;
  }
  return false;
}

/**
 * Returns one question per staple that at least one meal needs, in the order of STAPLES.
 * @param {object[]} meals Draft meals.
 * @param {Record<string, boolean>} pantry Previous answers, used to pre-fill the questions.
 * @returns {{staple: string, lastKnown: boolean | null}[]}
 */
export function staplesToAsk(meals, pantry) {
  const needed = new Set(meals.flatMap((meal) => meal.staples));
  return STAPLE_KEYS.filter((staple) => needed.has(staple)).map((staple) => ({
    staple,
    lastKnown: staple in pantry ? pantry[staple] : null,
  }));
}

/**
 * Filters meals that can be cooked and were not suggested recently.
 *
 * A meal is kept if all its staples are available, all its fridge ingredients are in
 * the confirmed ingredient list (or are basics/staples), and its name is not excluded.
 * Duplicate names are dropped.
 */
export function usableMeals(meals, ingredients, availableStaples, excluded) {
  const available = new Set(availableStaples);
  const allowedItems = new Set(
    [
      ...ingredients,
      ...ALWAYS_AVAILABLE,
      ...ALWAYS_AVAILABLE_LABELS,
      ...[...available].flatMap((staple) => [staple, STAPLES[staple] ?? staple]),
    ]
      .map(normalize)
      .filter(Boolean),
  );
  const seen = new Set(excluded.map(normalize));

  const result = [];
  for (const meal of meals) {
    const key = normalize(meal.name);
    if (seen.has(key)) continue;
    if (!meal.staples.every((staple) => available.has(staple))) continue;
    if (!meal.fridge_ingredients.every((item) => matchesAny(normalize(item), allowedItems))) continue;
    seen.add(key);
    result.push(meal);
  }
  return result;
}

/**
 * Picks up to `count` meals so that the round stays varied: each cooking technique at most
 * once and at most MAX_RICH_DAIRY meals built around cream or cheese, counting the meals in
 * `alreadyChosen`. Meals without a known technique are not limited by technique.
 */
export function pickVaried(meals, count, alreadyChosen = []) {
  const techniques = new Set(alreadyChosen.map((meal) => meal.technique).filter(Boolean));
  let richDairy = alreadyChosen.filter((meal) => meal.rich_dairy).length;
  const picked = [];
  for (const meal of meals) {
    if (picked.length >= count) break;
    if (meal.technique && techniques.has(meal.technique)) continue;
    if (meal.rich_dairy && richDairy >= MAX_RICH_DAIRY) continue;
    picked.push(meal);
    if (meal.technique) techniques.add(meal.technique);
    if (meal.rich_dairy) richDairy++;
  }
  return picked;
}

/** Describes what the chosen meals already use, for the follow-up prompt. */
function takenBy(meals) {
  return {
    usedTechniques: [...new Set(meals.map((meal) => meal.technique).filter(Boolean))],
    richDairyUsed: meals.filter((meal) => meal.rich_dairy).length >= MAX_RICH_DAIRY,
  };
}

/** Application logic between the UI and Gemini/memory. */
export class Planner {
  /**
   * @param {object} options
   * @param {{analyze: Function, plan: Function}} options.oracle Gemini client (or a fake in tests).
   * @param {import("./memory.js").Memory} options.memory Persistent memory.
   * @param {number} options.mealCount Meals per round.
   */
  constructor({ oracle, memory, mealCount }) {
    this.oracle = oracle;
    this.memory = memory;
    this.mealCount = mealCount;
  }

  /**
   * Analyzes the fridge photos and determines which staples to ask about.
   * @param {{data: string, mimeType: string}[]} photos Base64-encoded photos.
   */
  async analyze(photos) {
    const excluded = this.memory.excludedNames();
    const analysis = await this.oracle.analyze(photos, this.mealCount + DRAFT_RESERVE, excluded);
    const excludedKeys = new Set(excluded.map(normalize));
    const drafts = analysis.meals.filter((meal) => !excludedKeys.has(normalize(meal.name)));
    return {
      ingredients: analysis.ingredients,
      draftMeals: drafts,
      staplesToAsk: staplesToAsk(drafts, this.memory.pantry()),
    };
  }

  /**
   * Returns the final meal suggestions and records them in the memory.
   * @param {object} request
   * @param {string[]} request.ingredients Fridge items confirmed by the user.
   * @param {object[]} [request.draftMeals] Drafts to reuse; an empty list forces new suggestions.
   * @param {string[]} [request.availableStaples] Staples the user has.
   * @param {string[]} [request.missingStaples] Staples the user does not have.
   */
  async suggest({ ingredients, draftMeals = [], availableStaples = [], missingStaples = [] }) {
    this.memory.updatePantry(availableStaples, missingStaples);
    // Staples confirmed in an earlier session count as available unless denied now
    const pantry = this.memory.pantry();
    const available = STAPLE_KEYS.filter((staple) => pantry[staple] === true);
    const excluded = this.memory.excludedNames();

    const usable = usableMeals(draftMeals, ingredients, available, excluded);
    let chosen = pickVaried(usable, this.mealCount);
    // Usable meals skipped for variety; used only if Gemini cannot deliver enough varied meals
    const reserve = usable.filter((meal) => !chosen.includes(meal));
    for (let call = 0; call < MAX_PLAN_CALLS; call++) {
      const missingCount = this.mealCount - chosen.length;
      if (missingCount <= 0) break;
      const blocked = [...excluded, ...chosen.map((meal) => meal.name)];
      const plan = await this.oracle.plan(ingredients, available, missingCount, blocked, takenBy(chosen));
      const candidates = usableMeals(plan.meals, ingredients, available, blocked);
      const picked = pickVaried(candidates, missingCount, chosen);
      chosen = chosen.concat(picked);
      reserve.push(...candidates.filter((meal) => !picked.includes(meal)));
    }
    // A full list is more useful than a short one with perfect variety
    const names = new Set(chosen.map((meal) => normalize(meal.name)));
    for (const meal of reserve) {
      if (chosen.length >= this.mealCount) break;
      if (names.has(normalize(meal.name))) continue;
      names.add(normalize(meal.name));
      chosen.push(meal);
    }

    this.memory.record(
      chosen.map((meal) => meal.name),
      "suggested",
    );
    return chosen;
  }
}

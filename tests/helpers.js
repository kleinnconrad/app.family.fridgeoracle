// Shared test helpers: in-memory storage, controllable clock, meal factory and fake oracle.

export class RamStorage {
  items = new Map();
  getItem(key) {
    return this.items.get(key) ?? null;
  }
  setItem(key, value) {
    this.items.set(key, String(value));
  }
}

export class Clock {
  now = new Date("2026-01-01T12:00:00Z");
  advanceDays(days) {
    this.now = new Date(this.now.getTime() + days * 24 * 60 * 60 * 1000);
  }
  get fn() {
    return () => this.now;
  }
}

export function makeMeal(name, fridge = ["Eier"], staples = [], { technique = null, richDairy = false } = {}) {
  return {
    name,
    cuisine: "",
    technique,
    rich_dairy: richDairy,
    description: `${name} Beschreibung`,
    fridge_ingredients: fridge,
    staples,
    prep_minutes: 20,
    difficulty: "easy",
    steps: ["Kochen."],
  };
}

export class FakeOracle {
  constructor({ analysis = { ingredients: [], meals: [] }, plans = [] } = {}) {
    this.analysis = analysis;
    this.plans = [...plans];
    this.analyzeCalls = [];
    this.planCalls = [];
  }
  async analyze(photos, mealCount, excluded) {
    this.analyzeCalls.push({ photos, mealCount, excluded });
    return this.analysis;
  }
  async plan(ingredients, availableStaples, mealCount, excluded, taken = {}) {
    this.planCalls.push({ ingredients, availableStaples, mealCount, excluded, taken });
    return this.plans.shift() ?? { meals: [] };
  }
}

export function fridgeAnalysis() {
  return {
    ingredients: [
      { name: "Eier", quantity: "6" },
      { name: "Gouda", quantity: "halbes Stück" },
      { name: "Spinat", quantity: "1 Beutel" },
    ],
    meals: [
      makeMeal("Spinat-Omelett", ["Eier", "Spinat"], ["onions"]),
      makeMeal("Käse-Kartoffeln", ["Gouda"], ["potatoes"]),
      makeMeal("Rührei", ["Eier"]),
    ],
  };
}

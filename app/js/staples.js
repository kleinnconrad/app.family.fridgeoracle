// Basic ingredients outside the fridge that a meal may use.
//
// The model may only use fridge contents, the always-available basics and the
// staples below. The app asks the user about a staple only when a suggested meal
// needs it. Items that are usually kept in the fridge (eggs, milk, butter) are not
// staples: the model has to see them in the photo.

// Assumed to be present in every kitchen; the app never asks about these.
export const ALWAYS_AVAILABLE = ["salt", "black pepper", "cooking oil", "water"];
export const ALWAYS_AVAILABLE_LABELS = ["Salz", "Pfeffer", "Speiseöl", "Wasser"];

// Key: value used in the Gemini schema. Value: German label shown in the app.
export const STAPLES = {
  onions: "Zwiebeln",
  garlic: "Knoblauch",
  potatoes: "Kartoffeln",
  rice: "Reis",
  pasta: "Nudeln",
  flour: "Mehl",
  sugar: "Zucker",
  "canned tomatoes": "Dosentomaten",
  "tomato paste": "Tomatenmark",
  "stock cubes or broth": "Brühe (Würfel oder Pulver)",
  vinegar: "Essig",
  "dried herbs": "Getrocknete Kräuter",
  "paprika powder": "Paprikapulver",
};

export const STAPLE_KEYS = Object.keys(STAPLES);

export function stapleLabel(staple) {
  return STAPLES[staple] ?? staple;
}

import assert from "node:assert/strict";
import { test } from "node:test";

import { Memory } from "../app/js/memory.js";
import { Clock, RamStorage } from "./helpers.js";

test("suggested meals expire after the suggestion cooldown", () => {
  const clock = new Clock();
  const memory = new Memory(new RamStorage(), clock.fn);
  memory.record(["Nudeln mit Tomatensoße"], "suggested");

  clock.advanceDays(2);
  assert.deepEqual(memory.excludedNames(), ["Nudeln mit Tomatensoße"]);

  clock.advanceDays(2);
  assert.deepEqual(memory.excludedNames(), []);
});

test("cooked meals use the longer cooldown, rejected meals stay excluded", () => {
  const clock = new Clock();
  const memory = new Memory(new RamStorage(), clock.fn);
  memory.record(["Gulasch"], "cooked");
  memory.record(["Leber"], "rejected");

  clock.advanceDays(10);
  assert.deepEqual(new Set(memory.excludedNames()), new Set(["Gulasch", "Leber"]));

  clock.advanceDays(365);
  assert.deepEqual(memory.excludedNames(), ["Leber"]);
});

test("excluded names are unique per normalized name", () => {
  const memory = new Memory(new RamStorage());
  memory.record(["Gebratener Reis", "gebratener Reis!"], "suggested");
  assert.equal(memory.excludedNames().length, 1);
});

test("old suggestions are pruned from storage, history is kept", () => {
  const clock = new Clock();
  const memory = new Memory(new RamStorage(), clock.fn);
  memory.record(["Suppe"], "suggested");
  memory.record(["Curry"], "cooked");
  clock.advanceDays(30);
  memory.record(["Salat"], "suggested");

  assert.deepEqual(
    memory.load().events.map((event) => event.name),
    ["Curry", "Salat"],
  );
});

test("history lists cooked and rejected meals and entries can be deleted", () => {
  const memory = new Memory(new RamStorage());
  memory.record(["Suppe"], "suggested");
  memory.record(["Curry"], "cooked");
  memory.record(["Leber"], "rejected");

  const entries = memory.history();
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["Leber", "Curry"],
  );

  assert.equal(memory.deleteEvent(entries[0].id), true);
  assert.equal(memory.deleteEvent(entries[0].id), false);
  assert.ok(!memory.excludedNames().includes("Leber"));
});

test("pantry keeps the latest answer and ignores unknown staples", () => {
  const memory = new Memory(new RamStorage());
  memory.updatePantry(["onions", "rice"], ["potatoes"]);
  memory.updatePantry([], ["onions"]);
  memory.updatePantry(["caviar"], []);
  assert.deepEqual(memory.pantry(), { onions: false, rice: true, potatoes: false });
});

test("corrupt storage starts with an empty memory", () => {
  const storage = new RamStorage();
  storage.setItem("fridge-oracle:memory", "{not json");
  const memory = new Memory(storage);
  assert.deepEqual(memory.excludedNames(), []);
  memory.record(["Rührei"], "cooked");
  assert.equal(memory.history().length, 1);
});

// Run with: node --test src/sql/selection.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextSelection } from "./selection.ts";

const order = ["a", "b", "c", "d", "e"];
const sorted = (s: Set<string>) => [...s].sort();

test("a plain click toggles one file", () => {
  assert.deepEqual(sorted(nextSelection(order, new Set(), null, "b", false)), ["b"]);
  assert.deepEqual(sorted(nextSelection(order, new Set(["b", "c"]), "b", "b", false)), ["c"]);
});

test("shift-click extends a range from the anchor in either direction", () => {
  assert.deepEqual(sorted(nextSelection(order, new Set(["b"]), "b", "d", true)), ["b", "c", "d"]);
  assert.deepEqual(sorted(nextSelection(order, new Set(["d"]), "d", "a", true)), ["a", "b", "c", "d"]);
});

test("shift-click without an anchor toggles", () => {
  assert.deepEqual(sorted(nextSelection(order, new Set(), null, "c", true)), ["c"]);
});

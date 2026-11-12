import { test } from "node:test";
import assert from "node:assert/strict";
import { matches, pickCurrent, shownCatalogs } from "./catalogs.ts";

const all = ["hive_metastore", "main", "samples", "sandbox", "system"];

test("an empty selection shows every catalog", () => {
  assert.deepEqual(shownCatalogs(all, []), all);
});

test("a selection keeps catalog order and drops ones that no longer exist", () => {
  assert.deepEqual(shownCatalogs(all, ["sandbox", "gone", "main"]), ["main", "sandbox"]);
});

test("the saved catalog wins when it is still offered", () => {
  assert.equal(pickCurrent(all, "sandbox"), "sandbox");
});

test("falls back to main, then the first non-system catalog", () => {
  assert.equal(pickCurrent(all, "gone"), "main");
  assert.equal(pickCurrent(["system", "__internal", "dev"], ""), "dev");
  assert.equal(pickCurrent(["system"], ""), "system");
  assert.equal(pickCurrent([], "main"), "");
});

test("matching ignores case and surrounding space", () => {
  assert.ok(matches("Orders_Daily", " orders "));
  assert.ok(matches("anything", ""));
  assert.ok(!matches("customers", "ord"));
});

// Run with: node --test src/sql/csv.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { qualified, quoteIdent, toCSV } from "./csv.ts";

test("toCSV quotes only where needed and keeps NULL distinct from text", () => {
  const csv = toCSV(
    [{ name: "id" }, { name: "note, with comma" }],
    [
      ["1", "plain"],
      ["2", 'say "hi"'],
      ["3", "line\nbreak"],
      ["4", null],
      ["5", ""],
      null,
    ],
  );
  assert.equal(
    csv,
    ['id,"note, with comma"', "1,plain", '2,"say ""hi"""', '3,"line\nbreak"', "4,", "5,", "", ""].join("\r\n"),
  );
});

test("toCSV with no rows still writes the header", () => {
  assert.equal(toCSV([{ name: "a" }, { name: "b" }], []), "a,b\r\n");
});

test("quoteIdent leaves plain names alone and escapes the rest", () => {
  assert.equal(quoteIdent("orders"), "orders");
  assert.equal(quoteIdent("_tmp1"), "_tmp1");
  assert.equal(quoteIdent("my-catalog"), "`my-catalog`");
  assert.equal(quoteIdent("1st"), "`1st`");
  assert.equal(quoteIdent("has space"), "`has space`");
  assert.equal(quoteIdent("tick`name"), "`tick``name`");
});

test("qualified quotes each part on its own", () => {
  assert.equal(qualified("main", "sales", "orders"), "main.sales.orders");
  assert.equal(qualified("my-catalog", "raw.data", "t"), "`my-catalog`.`raw.data`.t");
});

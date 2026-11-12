// Run with: node --test src/sql/format.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSql, mapOffset } from "./format.ts";

test("formatSql lays out a query and uppercases keywords", () => {
  assert.equal(
    formatSql("select a, b from t where a=1 and b like 'x%'"),
    "SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  a = 1\n  AND b LIKE 'x%'",
  );
});

test("formatSql keeps Databricks operators intact", () => {
  const out = formatSql("select x::int, raw:store.bike, f(a => 1) from t");
  assert.match(out, /x::int/);
  assert.match(out, /raw:store\.bike/);
  assert.match(out, /f\(a => 1\)/);
});

test("formatSql does not put a space before a call to an unknown function", () => {
  const out = formatSql("select my_udf(1) from read_files('/Volumes/a/b', format => 'csv')");
  assert.match(out, /my_udf\(1\)/);
  assert.match(out, /read_files\('\/Volumes\/a\/b', FORMAT => 'csv'\)/);
});

test("formatSql treats QUALIFY as a clause", () => {
  assert.match(formatSql("select a from t qualify row_number() over (order by a) = 1"), /\nQUALIFY\n/);
});

test("formatSql keeps CREATE OR REPLACE TABLE on one line", () => {
  assert.equal(
    formatSql("create or replace table a.b.c (id bigint) using delta"),
    "CREATE OR REPLACE TABLE a.b.c (id bigint) USING delta",
  );
});

test("formatSql leaves strings, quoted names and comments alone", () => {
  const out = formatSql("-- note\nselect `my col`, \"dq\", 'it\\'s' from t");
  assert.match(out, /^-- note\n/);
  assert.match(out, /`my col`/);
  assert.match(out, /"dq"/);
  assert.match(out, /'it\\'s'/);
});

test("formatSql separates statements with a blank line", () => {
  assert.equal(formatSql("select 1; select 2;"), "SELECT\n  1;\n\nSELECT\n  2;");
});

test("formatSql keeps a trailing newline and leaves blank text alone", () => {
  assert.equal(formatSql("select 1\n"), "SELECT\n  1\n");
  assert.equal(formatSql("  \n"), "  \n");
});

test("formatSql throws on text it cannot parse", () => {
  assert.throws(() => formatSql("select 'unterminated"));
});

test("mapOffset keeps the cursor on the same code after formatting", () => {
  const before = "select a from t where b=1; select 2";
  const after = formatSql(before);
  const at = (s: string, needle: string) => s.indexOf(needle);
  assert.equal(mapOffset(before, after, at(before, "b=1")), at(after, "b = 1"));
  assert.equal(mapOffset(before, after, at(before, "2")), at(after, "2"));
  assert.equal(mapOffset(before, after, 0), 0);
  assert.equal(mapOffset(before, after, before.length), after.length);
});

// Run with: node --test src/sqlsplit.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, needsConfirm, splitStatements, statementAt } from "./sqlsplit.ts";

const parts = (text: string) => splitStatements(text).map((s) => text.slice(s.start, s.end).trim());

test("splits on semicolons and skips empty statements", () => {
  assert.deepEqual(parts("SELECT 1; SELECT 2;"), ["SELECT 1", "SELECT 2"]);
  assert.deepEqual(parts("SELECT 1;;\n ; SELECT 2"), ["SELECT 1", "SELECT 2"]);
  assert.deepEqual(parts(""), []);
  assert.deepEqual(parts("  \n -- just a comment\n"), []);
});

test("ignores semicolons in strings, quoted names and comments", () => {
  assert.deepEqual(parts("SELECT 'a;b'; SELECT 2"), ["SELECT 'a;b'", "SELECT 2"]);
  assert.deepEqual(parts("SELECT 'it''s; fine'; SELECT 2"), ["SELECT 'it''s; fine'", "SELECT 2"]);
  assert.deepEqual(parts("SELECT 'a\\'; b'; SELECT 2"), ["SELECT 'a\\'; b'", "SELECT 2"]);
  assert.deepEqual(parts('SELECT "x;y" FROM t; SELECT 2'), ['SELECT "x;y" FROM t', "SELECT 2"]);
  assert.deepEqual(parts("SELECT * FROM `my;table`; SELECT 2"), ["SELECT * FROM `my;table`", "SELECT 2"]);
  assert.deepEqual(parts("SELECT 1 -- note; not a split\n; SELECT 2"), ["SELECT 1 -- note; not a split", "SELECT 2"]);
  assert.deepEqual(parts("SELECT /* a;b */ 1; SELECT 2"), ["SELECT /* a;b */ 1", "SELECT 2"]);
});

test("survives unterminated strings and comments", () => {
  assert.deepEqual(parts("SELECT 'oops; SELECT 2"), ["SELECT 'oops; SELECT 2"]);
  assert.deepEqual(parts("SELECT 1; /* open"), ["SELECT 1"]);
});

test("statementAt picks the statement under the cursor", () => {
  const text = "SELECT 1;\nSELECT 2;\nSELECT 3";
  assert.equal(statementAt(text, 0), "SELECT 1");
  assert.equal(statementAt(text, 8), "SELECT 1"); // on the semicolon
  assert.equal(statementAt(text, 9), "SELECT 1"); // right after it, same line
  assert.equal(statementAt(text, 10), "SELECT 2"); // start of the next line
  assert.equal(statementAt("SELECT 1;   \nSELECT 2", 11), "SELECT 1"); // trailing spaces
  assert.equal(statementAt("SELECT 1; SELECT 2", 9), "SELECT 1");
  assert.equal(statementAt("SELECT 1; SELECT 2", 11), "SELECT 2");
  assert.equal(statementAt(text, 15), "SELECT 2");
  assert.equal(statementAt(text, text.length), "SELECT 3");
});

test("statementAt falls back to the previous statement in a gap", () => {
  const text = "SELECT 1;\n\n";
  assert.equal(statementAt(text, text.length), "SELECT 1");
  assert.equal(statementAt("SELECT 1; ; SELECT 2", 10), "SELECT 1");
  assert.equal(statementAt("  ; SELECT 2", 0), "SELECT 2");
  assert.equal(statementAt("", 0), "");
  assert.equal(statementAt("-- nothing here", 3), "");
});

test("classify reads the leading keyword", () => {
  for (const sql of [
    "select * from t",
    "  WITH x AS (SELECT 1) SELECT * FROM x",
    "SHOW TABLES",
    "DESCRIBE t",
    "EXPLAIN DROP TABLE t",
    "(SELECT 1)",
    "-- comment\n/* block */ SELECT 1",
    "FROM t |> WHERE x > 1",
    "",
  ]) {
    assert.equal(classify(sql), "read", sql);
  }
  for (const sql of [
    "INSERT INTO t VALUES (1)",
    "update t set a = 1",
    "MERGE INTO t USING s ON ...",
    "CREATE TABLE t (a INT)",
    "ALTER TABLE t ADD COLUMN b INT",
    "GRANT SELECT ON t TO `a`",
    "OPTIMIZE t",
    "SOMETHING_NEW t",
  ]) {
    assert.equal(classify(sql), "write", sql);
  }
  for (const sql of [
    "DROP TABLE t",
    "-- cleanup\ndrop schema s cascade",
    "TRUNCATE TABLE t",
    "DELETE FROM t",
    "CREATE OR REPLACE TABLE t AS SELECT 1",
    "create  or\nreplace view v as select 1",
    "INSERT OVERWRITE t SELECT 1",
  ]) {
    assert.equal(classify(sql), "destructive", sql);
  }
});

test("needsConfirm is stricter on production", () => {
  assert.equal(needsConfirm("read", true), false);
  assert.equal(needsConfirm("write", true), true);
  assert.equal(needsConfirm("destructive", true), true);
  assert.equal(needsConfirm("read", false), false);
  assert.equal(needsConfirm("write", false), false);
  assert.equal(needsConfirm("destructive", false), true);
});

// Run with: node --test src/notebook/command.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { body, languageOf, planCell, sqlToPython } from "./command.ts";

test("Python cells run as they are", () => {
  assert.deepEqual(planCell("x = 1"), { kind: "python", code: "x = 1" });
  assert.deepEqual(planCell("%python\nx = 1"), { kind: "python", code: "x = 1" });
  assert.deepEqual(planCell("  \n"), { kind: "empty" });
});

test("SQL cells become spark.sql calls, displaying the last statement", () => {
  const plan = planCell("%sql\nUSE CATALOG main;\n-- note\nSELECT 'a;b' AS x;\n");
  assert.equal(plan.kind, "sql");
  if (plan.kind !== "sql") return;
  assert.deepEqual(plan.statements, ["USE CATALOG main", "-- note\nSELECT 'a;b' AS x"]);
  assert.equal(
    plan.code,
    [
      "__dbx_sql = [",
      '    "USE CATALOG main",',
      '    "-- note\\nSELECT \'a;b\' AS x",',
      "]",
      "for __dbx_stmt in __dbx_sql[:-1]:",
      "    spark.sql(__dbx_stmt)",
      "display(spark.sql(__dbx_sql[-1]))",
    ].join("\n"),
  );
  assert.deepEqual(planCell("%sql\n-- nothing"), { kind: "empty" });
});

test("string escapes survive into Python", () => {
  assert.equal(sqlToPython(['SELECT "q", \'\\n\'']).split("\n")[1], '    "SELECT \\"q\\", \'\\\\n\'",');
});

test("markdown and unsupported magics", () => {
  assert.deepEqual(planCell("%md\n# Hi"), { kind: "markdown", text: "# Hi" });
  const sh = planCell("%sh\nls");
  assert.equal(sh.kind, "unsupported");
  if (sh.kind === "unsupported") assert.equal(sh.magic, "%sh");
  assert.deepEqual(planCell("%pip install faker  holidays\n"), { kind: "pip", args: "faker holidays" });
  assert.equal(planCell("%pip list").kind, "unsupported");
});

test("languageOf", () => {
  assert.equal(languageOf("print(1)"), "python");
  assert.equal(languageOf("%sql\nSELECT 1"), "sql");
  assert.equal(languageOf("  %md\nhi"), "markdown");
  assert.equal(languageOf("%scala\n1"), "other");
  assert.equal(languageOf("%md-sandbox\n<b>x</b>"), "markdown");
});

test("text on the magic line belongs to the cell", () => {
  assert.equal(body("%md ## 1. Create schema"), "## 1. Create schema");
  assert.equal(body("%md\n# Hi"), "# Hi");
  assert.equal(body("%md"), "");
  assert.deepEqual(planCell("%md ## Title\nmore"), { kind: "markdown", text: "## Title\nmore" });
  const plan = planCell("%sql SELECT 1");
  assert.equal(plan.kind, "sql");
  if (plan.kind === "sql") assert.deepEqual(plan.statements, ["SELECT 1"]);
});

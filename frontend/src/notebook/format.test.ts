// Run with: node --test src/notebook/format.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNotebook, serializeNotebook, type Cell } from "./format.ts";

const plain = (cells: Cell[]) => cells.map(({ source, title }) => ({ source, title }));

const SAMPLE = `# Databricks notebook source
import os
print(os.getcwd())

# COMMAND ----------

# MAGIC %md
# MAGIC # Load orders
# MAGIC
# MAGIC Reads the raw feed.

# COMMAND ----------

# DBTITLE 1,Count rows
# MAGIC %sql
# MAGIC SELECT count(*)
# MAGIC FROM samples.tpch.orders

# COMMAND ----------

def f(x):

    return x + 1
`;

test("parses cells, magics and titles", () => {
  assert.deepEqual(plain(parseNotebook(SAMPLE)), [
    { source: "import os\nprint(os.getcwd())", title: "" },
    { source: "%md\n# Load orders\n\nReads the raw feed.", title: "" },
    { source: "%sql\nSELECT count(*)\nFROM samples.tpch.orders", title: "Count rows" },
    { source: "def f(x):\n\n    return x + 1", title: "" },
  ]);
});

test("writes back the same source", () => {
  assert.equal(serializeNotebook(parseNotebook(SAMPLE)), SAMPLE);
});

test("gives each cell its own id", () => {
  const ids = parseNotebook(SAMPLE).map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("an empty or header-only file is one empty cell", () => {
  assert.deepEqual(plain(parseNotebook("")), [{ source: "", title: "" }]);
  assert.deepEqual(plain(parseNotebook("# Databricks notebook source\n")), [{ source: "", title: "" }]);
});

test("a plain Python script is one cell", () => {
  assert.deepEqual(plain(parseNotebook("x = 1\r\nprint(x)\r\n")), [{ source: "x = 1\nprint(x)", title: "" }]);
});

test("a Python cell with a comment that mentions MAGIC stays Python", () => {
  const text = "# Databricks notebook source\n# MAGIC is fun\nx = 1\n";
  assert.deepEqual(plain(parseNotebook(text)), [{ source: "# MAGIC is fun\nx = 1", title: "" }]);
});

test("magic cells are prefixed on write, blank lines included", () => {
  const out = serializeNotebook([{ id: "a", source: "%sql\nSELECT 1\n\nSELECT 2", title: "" }]);
  assert.equal(out, "# Databricks notebook source\n# MAGIC %sql\n# MAGIC SELECT 1\n# MAGIC\n# MAGIC SELECT 2\n");
});

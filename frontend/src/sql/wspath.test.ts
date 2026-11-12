import { test } from "node:test";
import assert from "node:assert/strict";
import { crumbs, sqlName, suggestedName } from "./wspath.ts";

test("crumbs splits a folder into clickable steps", () => {
  assert.deepEqual(crumbs("/Users/me@x.com/q"), [
    { name: "Workspace", path: "/" },
    { name: "Users", path: "/Users" },
    { name: "me@x.com", path: "/Users/me@x.com" },
    { name: "q", path: "/Users/me@x.com/q" },
  ]);
  assert.deepEqual(crumbs("/"), [{ name: "Workspace", path: "/" }]);
});

test("sqlName adds .sql and rejects paths", () => {
  assert.equal(sqlName(" revenue "), "revenue.sql");
  assert.equal(sqlName("a.SQL"), "a.SQL");
  assert.equal(sqlName("a/b"), "");
  assert.equal(sqlName("  "), "");
  assert.equal(sqlName(".."), "");
});

test("suggestedName drops Untitled names", () => {
  assert.equal(suggestedName("Untitled-3.sql"), "");
  assert.equal(suggestedName("daily.sql"), "daily");
});

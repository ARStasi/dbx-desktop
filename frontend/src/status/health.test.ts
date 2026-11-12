import test from "node:test";
import assert from "node:assert/strict";
import { watchSummary } from "./health.ts";

const now = 2_000_000;
const provider = (id = "aws") => ({ id, name: id, url: "", fetchedAt: now, error: "", regions: [
  { id: "east", name: "East", health: "operational", services: [], events: [] },
  { id: "west", name: "West", health: "outage", services: [], events: [] },
] });

test("only watched regions determine the indicator, across providers", () => {
  const providers = [provider(), provider("azure")];
  assert.equal(watchSummary(providers, { aws: ["east"] }, now).health, "operational");
  assert.equal(watchSummary(providers, { aws: ["east"], azure: ["west"] }, now).health, "outage");
  assert.equal(watchSummary(providers, {}, now).health, "unknown");
});

test("stale, failed, missing feeds and removed regions are never green", () => {
  const p = provider();
  for (const providers of [[], [{ ...p, error: "offline" }], [{ ...p, fetchedAt: now - 600_001 }]]) {
    assert.equal(watchSummary(providers, { aws: ["east"] }, now).health, "unknown");
  }
  assert.equal(watchSummary([p], { aws: ["removed"] }, now).health, "unknown");
  assert.equal(watchSummary([p], { aws: ["east", "removed"] }, now).health, "unknown");
});

test("a known disruption remains visible alongside an unavailable provider", () => {
  const result = watchSummary([provider()], { aws: ["west"], gcp: ["east"] }, now);
  assert.equal(result.health, "outage");
  assert.match(result.text, /1 region needs attention/);
  assert.match(result.text, /1 unavailable/);
});

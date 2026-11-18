import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSummary } from "../../../src/ideas";
import { groupByDate } from "./groupByDate";

function row(id: string, createdAt: string, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    num: 0, id, title: id, status: "max_rounds", rounds: 1, scenarios: 0,
    createdAt, updatedAt: createdAt, depth: 0, active: false, interrupted: false, ...extra,
  };
}

test("groups top-level ideas by creation date and keeps branches with their parent", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  // listRuns order: newest first, branches right under their parent.
  const rows = [
    row("today", "2026-11-13T11:00:00Z"),
    row("week", "2026-11-10T11:00:00Z"),
    row("old", "2026-10-01T11:00:00Z"),
    row("old-branch", "2026-11-13T11:30:00Z", { depth: 1, parent: { id: "old", fromRound: 1 } }),
  ];
  const groups = groupByDate(rows, now);
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Previous 7 days", "Older"]);
  assert.deepEqual(groups.map((g) => g.rows.map((r) => r.id)), [["today"], ["week"], ["old", "old-branch"]]);
});

test("leaves out empty groups", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const groups = groupByDate([row("old", "2026-01-01T11:00:00Z")], now);
  assert.deepEqual(groups.map((g) => g.label), ["Older"]);
  assert.deepEqual(groupByDate([], now), []);
});

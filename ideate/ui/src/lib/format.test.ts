import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSummary } from "../../../src/ideas";
import type { Issue } from "../../../src/schema";
import { avatar, clipLines, plural, rowLabel, rowMeta, scoreChip, splitIssues } from "./format";

const row = (extra: Partial<RunSummary>): RunSummary => ({
  num: 1, id: "x", title: "CHW visit sync", status: "max_rounds", rounds: 5, scenarios: 0,
  createdAt: "", updatedAt: "", depth: 0, active: false, interrupted: false, ...extra,
});

test("row meta shows a tick for converged ideas, else the round and last mean", () => {
  assert.equal(rowMeta(row({ status: "converged", lastMean: 8.5 })), "✓ 8.5");
  assert.equal(rowMeta(row({ lastMean: 6 })), "r5 · 6.0");
  assert.equal(rowMeta(row({ rounds: 0 })), "");
});

test("branch rows are labelled with the round they came from", () => {
  assert.equal(rowLabel(row({ title: "shared phones", depth: 1, parent: { id: "p", fromRound: 2 } })), "r2: shared phones");
  assert.equal(rowLabel(row({})), "CHW visit sync");
});

test("score chip and plurals", () => {
  assert.equal(scoreChip(6, 0), "mean 6.0 · 0 blockers");
  assert.equal(scoreChip(7.25, 1), "mean 7.3 · 1 blocker");
  assert.equal(plural(1, "scenario"), "1 scenario");
  assert.equal(plural(3, "scenario"), "3 scenarios");
});

test("avatars: primary in Claude orange, reviewers by position, grey after two", () => {
  const sec = ["agy", "codex", "gem"];
  assert.deepEqual(avatar("primary", "claude", sec), { letter: "C", color: "#d97757" });
  assert.deepEqual(avatar("reviewer", "agy", sec), { letter: "A", color: "#4285f4" });
  assert.deepEqual(avatar("reviewer", "codex", sec), { letter: "B", color: "#10a37f" });
  assert.deepEqual(avatar("reviewer", "gem", sec), { letter: "C", color: "#9a9a9a" });
});

test("splitIssues keeps blockers and majors visible, minors behind the toggle", () => {
  const i = (id: string, severity: Issue["severity"]): Issue => ({ id, severity, category: "ops", finding: "f", recommendation: "r" });
  const { shown, minors } = splitIssues([i("a", "minor"), i("b", "major"), i("c", "blocker")]);
  assert.deepEqual(shown.map((x) => x.id), ["c", "b"]);
  assert.deepEqual(minors.map((x) => x.id), ["a"]);
});

test("clipLines cuts long text to the first n lines", () => {
  const long = Array.from({ length: 45 }, (_, k) => `line ${k + 1}`).join("\n");
  assert.deepEqual(clipLines(long, 40), { text: long.split("\n").slice(0, 40).join("\n"), clipped: true });
  assert.deepEqual(clipLines("a\nb", 40), { text: "a\nb", clipped: false });
});

test("clipLines ends at a paragraph break in the second half rather than mid-block", () => {
  const lines = Array.from({ length: 45 }, (_, k) => `line ${k + 1}`);
  lines[29] = ""; // blank line 30: a table starts at 31
  assert.deepEqual(clipLines(lines.join("\n"), 40), { text: lines.slice(0, 29).join("\n"), clipped: true });
});

test("clipLines also cuts a few very long lines to maxChars, at a line or word break", () => {
  const huge = "word ".repeat(40_000); // 200 KB on one line
  const c = clipLines(huge, 40, 3000);
  assert.equal(c.clipped, true);
  assert.ok(c.text.length <= 3000 && c.text.length > 2900, String(c.text.length));
  assert.ok(c.text.endsWith("word"));
  const para = `${"a".repeat(2000)}\n\n${"b".repeat(2000)}`;
  assert.deepEqual(clipLines(para, 40, 3000), { text: "a".repeat(2000), clipped: true });
  assert.deepEqual(clipLines("short", 40, 3000), { text: "short", clipped: false });
});

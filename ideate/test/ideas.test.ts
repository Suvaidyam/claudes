import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addScenario, activeScenarios, applyContinue, branchRun, editScenario, ideaTitle, listRuns, pastIssues, removeScenario, resolveRunRef,
} from "../src/ideas.js";
import type { RunState } from "../src/store.js";

const issue = (id: string, severity = "major") => ({ id, severity: severity as "major", category: "other", finding: `f ${id}`, recommendation: `r ${id}` });
const review = (score: number, ids: string[]) => ({ score, confidence: 0.8, summary: "", strengths: [], issues: ids.map((i) => issue(i)) });

function state(id: string, updatedAt: string, extra: Partial<RunState> = {}): RunState {
  return {
    id, createdAt: updatedAt, updatedAt, status: "max_rounds", brief: `# Brief for ${id}\nmore`,
    primary: "p", secondaries: ["a", "b"], rounds: [], ...extra,
  };
}

function writeRuns(states: RunState[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ideate-ideas-"));
  for (const s of states) {
    mkdirSync(join(dir, s.id));
    writeFileSync(join(dir, s.id, "state.json"), JSON.stringify(s));
  }
  return dir;
}

test("listRuns: newest idea first, stable creation-order numbers, branches under their parent, broken folders skipped", () => {
  const dir = writeRuns([
    state("old", "2026-01-01T00:00:00Z"),
    state("new", "2026-03-01T00:00:00Z"),
    state("old-branch", "2026-04-01T00:00:00Z", { parent: { id: "old", fromRound: 1 } }),
    state("orphan", "2026-02-01T00:00:00Z", { parent: { id: "deleted", fromRound: 1 } }),
  ]);
  mkdirSync(join(dir, "broken"));
  writeFileSync(join(dir, "broken", "state.json"), "{ not json");
  mkdirSync(join(dir, "empty"));

  const runs = listRuns(dir);
  assert.deepEqual(runs.map((r) => [r.num, r.id, r.depth]), [[3, "new", 0], [2, "orphan", 0], [1, "old", 0], [4, "old-branch", 1]]);
  assert.equal(resolveRunRef(runs, "4").id, "old-branch");
  assert.equal(resolveRunRef(runs, "1").id, "old");
  assert.equal(resolveRunRef(runs, "orphan").id, "orphan");
  assert.throws(() => resolveRunRef(runs, "9"), /No idea #9/);
  assert.throws(() => resolveRunRef(runs, "nope"), /No run with ID/);
  assert.deepEqual(listRuns(join(dir, "missing")), []);
});

test("ideaTitle uses the title, else the brief's first line without markdown, trimmed", () => {
  assert.equal(ideaTitle(state("x", "t", { title: "  CHW sync " })), "CHW sync");
  assert.equal(ideaTitle(state("x", "t")), "Brief for x");
  assert.equal(ideaTitle(state("x", "t", { brief: "a".repeat(80) })).length, 60);
});

test("pastIssues: refs, dispositions and outcomes", () => {
  const s = state("x", "t", {
    rounds: [
      {
        round: 1, proposal: "p1", reviews: { a: review(5, ["X-1", "X-2"]), b: review(6, ["Y-1"]) }, meanScore: 5.5, blockers: 0,
        revision: { proposal: "p2", dispositions: [
          { issue_ref: "A:X-1", action: "rejected", rationale: "no" },
          { issue_ref: "B:Y-1", action: "accepted", rationale: "yes" },
        ] },
      },
      { round: 2, proposal: "p2", reviews: { a: review(6, ["X-1"]), b: review(7, []) }, meanScore: 6.5, blockers: 0 },
    ],
  });
  const byRef = Object.fromEntries(pastIssues(s).map((p) => [p.ref, p.outcome]));
  assert.deepEqual(byRef, {
    "r1:a:X-1": "rejected · raised again",
    "r1:a:X-2": "unanswered",
    "r1:b:Y-1": "accepted",
    "r2:a:X-1": "open",
  });
});

test("scenarios: ids are never reused, edits and removals are recorded", () => {
  const s = state("x", "t");
  assert.equal(addScenario(s, 1, "shared phones").id, "S1");
  assert.equal(addScenario(s, 1, "  no power  ").text, "no power");
  removeScenario(s, 2, "S1");
  assert.equal(addScenario(s, 2, "flooding").id, "S3");
  editScenario(s, 3, "s2", "no power for a week");
  assert.deepEqual(activeScenarios(s).map((x) => [x.id, x.text, x.editedRound]), [["S2", "no power for a week", 3], ["S3", "flooding", undefined]]);
  assert.throws(() => editScenario(s, 3, "S1", "x"), /No active scenario/);
  assert.throws(() => addScenario(s, 3, "   "), /can't be empty/);
});

test("branchRun copies up to the round, drops its revision, keeps earlier scenarios, leaves the source alone", () => {
  const src = state("src", "t", {
    scenarios: [{ id: "S1", text: "early", addedRound: 1 }, { id: "S2", text: "late", addedRound: 3 }],
    rounds: [1, 2, 3].map((n) => ({
      round: n, proposal: `p${n}`, reviews: { a: review(5, []), b: review(5, []) }, meanScore: 5, blockers: 0,
      revision: { proposal: `p${n + 1}`, dispositions: [] }, humanFeedback: "fb",
    })),
  });
  const before = JSON.stringify(src);
  const b = branchRun(src, 2, "new-id", "2026-11-12T00:00:00Z");

  assert.equal(JSON.stringify(src), before, "source untouched");
  assert.equal(b.id, "new-id");
  assert.deepEqual(b.parent, { id: "src", fromRound: 2 });
  assert.equal(b.rounds.length, 2);
  assert.ok(b.rounds[0]!.revision, "earlier rounds keep their revision");
  assert.equal(b.rounds[1]!.revision, undefined);
  assert.equal(b.rounds[1]!.humanFeedback, undefined);
  assert.deepEqual(b.scenarios!.map((x) => x.id), ["S1"]);
  assert.throws(() => branchRun(src, 4, "z"), /between 1 and 3/);
});

test("branchRun: the branch point gets a fresh gate and an empty inbox", () => {
  const src = state("src", "t", {
    inboxConsumed: 120, inboxMoreApplied: ["x"],
    rounds: [1, 2].map((n) => ({
      round: n, proposal: `p${n}`, reviews: { a: review(5, []) }, meanScore: 5, blockers: 0,
      revision: { proposal: `p${n + 1}`, dispositions: [] }, gateDone: true as const,
    })),
  });
  const b = branchRun(src, 2, "new-id");
  assert.equal(b.rounds[1]!.gateDone, undefined);
  assert.equal(b.rounds[0]!.gateDone, true, "earlier rounds keep their history");
  assert.equal(b.inboxConsumed, undefined);
  assert.equal(b.inboxMoreApplied, undefined);
  assert.equal(src.inboxConsumed, 120, "the parent keeps its queue");
});

test("applyContinue appends --note to feedback already on the round", () => {
  const s = state("s", "t", { rounds: [{ round: 1, proposal: "p", reviews: {}, meanScore: 5, humanFeedback: "A" }] });
  applyContinue(s, { reopen: [], note: " B ", more: 1 });
  assert.equal(s.rounds[0]!.humanFeedback, "A\n\nB");
});

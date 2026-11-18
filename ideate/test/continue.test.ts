import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { emptyPlan, prepareContinue, type ContinuePlan } from "../src/continue.js";
import { listRuns } from "../src/ideas.js";
import { IdeationLoop } from "../src/loop.js";
import type { Provider } from "../src/providers.js";
import { renderReport } from "../src/report.js";
import { RunStore } from "../src/store.js";
import { config, review, runLoop, scripted, transcript } from "./helpers.js";

/** A primary that answers every "[X:Y]" ref in a revise prompt (reviewer and OWNER refs). */
const answeringPrimary = (skip: (ref: string) => boolean = () => false) =>
  scripted("p", (prompt, role) => {
    if (role === "generate") return "## Proposal";
    const refs = [...new Set([...prompt.matchAll(/\[([A-Z]+:[A-Za-z0-9-]+)\]/g)].map((m) => m[1]!))].filter((r) => !skip(r));
    const dispositions = refs.map((ref) => ({ issue_ref: ref, action: "accepted", rationale: `ok ${ref}` }));
    return prompt.includes("did not give a disposition")
      ? JSON.stringify({ dispositions })
      : JSON.stringify({ proposal: "## Revised", dispositions });
  });

/** Runs a fresh idea to a stop, then returns everything needed to continue it. */
async function stoppedRun(loop: Record<string, unknown>, scores: { a: number; b: number }, primary: Provider = answeringPrimary()) {
  const cfg = config(loop);
  const a = scripted("a", () => review(scores.a, [{ id: "X-1" }]));
  const b = scripted("b", () => review(scores.b, []));
  const providers = new Map<string, Provider>([["p", primary], ["a", a], ["b", b]]);
  const first = runLoop(cfg, providers);
  const state = await first.done;
  return { cfg, providers, state, store: first.store };
}

async function cont(cfg: ReturnType<typeof config>, providers: Map<string, Provider>, plan: ContinuePlan) {
  const prepared = prepareContinue(cfg.runsDir, plan);
  cfg.loop.maxRounds = prepared.fromRound + plan.more;
  const logs: string[] = [];
  const final = await new IdeationLoop(cfg, providers, prepared.store, prepared.state, { log: (m) => logs.push(m) }, { continueRun: true }).run();
  return { ...prepared, final, logs };
}

test("continuing a max_rounds run runs exactly --more extra rounds", async () => {
  const { cfg, providers, state } = await stoppedRun({ maxRounds: 2 }, { a: 5, b: 6 });
  assert.equal(state.status, "max_rounds");
  assert.equal(state.rounds.length, 2);

  const { final } = await cont(cfg, providers, { ...emptyPlan(state.id), more: 2 });
  assert.equal(final.status, "max_rounds");
  assert.equal(final.rounds.length, 4);
  assert.ok(final.rounds[1]!.revision, "round 2, where it had stopped, got revised");
  assert.ok(final.rounds[1]!.continuedAt);
});

test("continuing a converged run still revises it once more", async () => {
  const { cfg, providers, state } = await stoppedRun({ maxRounds: 3 }, { a: 9, b: 9 });
  assert.equal(state.status, "converged");
  assert.equal(state.rounds.length, 1);

  const { final } = await cont(cfg, providers, { ...emptyPlan(state.id), more: 1 });
  assert.equal(final.status, "converged");
  assert.equal(final.rounds.length, 2);
});

test("stagnation only counts rounds after the continue point", async () => {
  const { cfg, providers, state } = await stoppedRun({ maxRounds: 10, stagnationRounds: 2 }, { a: 5, b: 5 });
  assert.equal(state.status, "stagnated");
  const stoppedAt = state.rounds.length;

  const { final } = await cont(cfg, providers, { ...emptyPlan(state.id), more: 10 });
  assert.equal(final.status, "stagnated");
  // Needs stagnationRounds + 1 fresh rounds after the continue point, not one.
  assert.equal(final.rounds.length, stoppedAt + 3);
});

test("a new scenario reaches the primary and reviewers, marked NEW only in the round it was added", async () => {
  const { cfg, providers, state, store } = await stoppedRun({ maxRounds: 1 }, { a: 5, b: 6 });
  await cont(cfg, providers, { ...emptyPlan(state.id), addScenarios: ["Two CHWs share one phone"], more: 2 });

  const t = transcript(store);
  const at = (role: string, round: number, provider?: string) =>
    t.find((e) => e.role === role && e.round === round && (!provider || e.provider === provider))!.prompt;
  assert.match(at("revise", 1), /# Scenarios the design must handle\n- S1 \(NEW this round\): Two CHWs share one phone/);
  assert.match(at("revise", 1), /must handle every scenario/);
  assert.match(at("review", 2, "a"), /- S1 \(NEW this round\): Two CHWs share one phone/);
  assert.match(at("review", 2, "a"), /category "scenario"/);
  assert.match(at("revise", 2), /- S1: Two CHWs share one phone/);
  assert.match(at("review", 3, "b"), /- S1: Two CHWs share one phone/);
  assert.doesNotMatch(at("review", 1, "a"), /Scenarios the design/, "round-1 reviews predate the scenario");

  const after = RunStore.load(cfg.runsDir, state.id).state;
  assert.deepEqual(after.scenarios, [{ id: "S1", text: "Two CHWs share one phone", addedRound: 1 }]);
  assert.match(renderReport(after), /## Scenarios\n\n- \*\*S1\*\*: Two CHWs share one phone \(added r1\)/);
});

test("reopened issues must be answered, and reviewers see the author's response", async () => {
  // The primary skips OWNER refs in its revision, so the follow-up has to catch them.
  const primary = answeringPrimary();
  const skipping = scripted("p", (prompt, role, call) =>
    !prompt.includes("did not give a disposition") && role === "revise"
      ? primary.complete(prompt.replace(/\[OWNER:\d+\]/g, ""), role)
      : primary.complete(prompt, role));
  const { cfg, providers, state, store } = await stoppedRun({ maxRounds: 2 }, { a: 5, b: 6 }, skipping);

  const { final, logs } = await cont(cfg, providers, { ...emptyPlan(state.id), reopen: ["R1:A:x-1"], note: "Prefer fewer moving parts", more: 1 });
  const r2 = final.rounds[1]!;
  assert.deepEqual(r2.reopened, [{ ref: "r1:a:X-1", issue: final.rounds[0]!.reviews.a!.issues[0] }]);
  assert.ok(logs.some((l) => l.includes("asking for dispositions")));
  assert.deepEqual(r2.undisposed, []);
  assert.ok(r2.revision!.dispositions.some((d) => d.issue_ref === "OWNER:1"));

  const t = transcript(store);
  const revise2 = t.find((e) => e.role === "revise" && e.round === 2)!.prompt;
  assert.match(revise2, /Issues the human owner reopened[\s\S]*\[OWNER:1\] \(major, other\) finding X-1/);
  assert.match(revise2, /Feedback from the human owner \(highest priority\)\nPrefer fewer moving parts/);
  const review3 = t.find((e) => e.role === "review" && e.round === 3 && e.provider === "b")!.prompt;
  assert.match(review3, /Issues the owner reopened last round[\s\S]*OWNER:1 \(major, other\): finding X-1[\s\S]*Author: ACCEPTED/);
  assert.doesNotMatch(review3, /r1:a:/, "reviewers don't see other reviewers' names");
  assert.match(renderReport(final), /## Issues you reopened\n\n- r2 r1:a:X-1 \(major\) finding X-1\n  accepted:/);
});

test("branching creates a new linked run and leaves the original untouched", async () => {
  const { cfg, providers, state } = await stoppedRun({ maxRounds: 3, stagnationRounds: 5 }, { a: 5, b: 6 });
  assert.equal(state.rounds.length, 3);
  const statePath = join(cfg.runsDir, state.id, "state.json");
  const hash = () => createHash("sha256").update(readFileSync(statePath)).digest("hex");
  const before = hash();

  const { final, changes } = await cont(cfg, providers, {
    ...emptyPlan(state.id), fromRound: 2, addScenarios: ["Floods cut roads for weeks"], reopen: ["r3:a:X-1"], more: 1,
  });
  assert.equal(hash(), before, "original state.json unchanged");
  assert.notEqual(final.id, state.id);
  assert.deepEqual(final.parent, { id: state.id, fromRound: 2 });
  assert.equal(final.rounds.length, 3, "branched at 2, one more round");
  assert.equal(final.rounds[1]!.reopened![0]!.ref, "r3:a:X-1", "issues from after the branch point can be reopened");
  assert.match(changes[1]!, /Branched .* at round 2 → new run/);

  const rows = listRuns(cfg.runsDir);
  assert.deepEqual(rows.map((r) => [r.id, r.depth]), [[state.id, 0], [final.id, 1]]);
  assert.match(readFileSync(join(cfg.runsDir, final.id, "round-1", "proposal.md"), "utf8"), /Proposal/);
});

test("a bad scenario id fails before anything is written", async () => {
  const { cfg, state } = await stoppedRun({ maxRounds: 2 }, { a: 5, b: 6 });
  const before = readFileSync(join(cfg.runsDir, state.id, "state.json"), "utf8");
  assert.throws(() => prepareContinue(cfg.runsDir, { ...emptyPlan(state.id), fromRound: 1, removeScenarios: ["S9"] }), /No active scenario "S9"/);
  assert.equal(listRuns(cfg.runsDir).length, 1, "no branch folder left behind");
  assert.equal(readFileSync(join(cfg.runsDir, state.id, "state.json"), "utf8"), before);
});

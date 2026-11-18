import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { IdeationLoop } from "../src/loop.js";
import { buildProviders, QuotaError } from "../src/providers.js";
import { renderReport } from "../src/report.js";
import { RunStore } from "../src/store.js";
import { config, review, runLoop, scripted, transcript } from "./helpers.js";

const revision = (dispositions: { issue_ref: string; action: string }[]) =>
  JSON.stringify({ proposal: "## Revised", dispositions: dispositions.map((d) => ({ ...d, rationale: "because" })) });

test("converges with mock providers and asks for skipped dispositions", async () => {
  const cfg = config({ maxRounds: 4 });
  const providers = buildProviders({
    p: { type: "mock", startScore: 5, step: 1.5, skipDispositions: true },
    a: { type: "mock", startScore: 5, step: 1.5, skipDispositions: false },
    b: { type: "mock", startScore: 6, step: 1.5, skipDispositions: false },
  }, ["p", "a", "b"], 10);
  const { store, logs, done } = runLoop(cfg, providers);
  const state = await done;

  assert.equal(state.status, "converged");
  assert.ok(logs.some((l) => l.includes("asking for dispositions")));
  assert.deepEqual(state.rounds[0]!.undisposed, []);
  assert.deepEqual(state.rounds[0]!.revision!.dispositions.map((d) => d.issue_ref).sort(), ["A:OPS-1", "A:SEC-1", "B:OPS-1", "B:SEC-1"]);
  assert.ok(existsSync(join(store.dir, "state.json")));
  assert.ok(!readdirSync(store.dir).some((f) => f.endsWith(".tmp")), "no temp checkpoint left behind");
});

test("round-2 reviewers see their own previous issues and the author's response, not other reviewers'", async () => {
  const cfg = config({ maxRounds: 2 });
  const p = scripted("p", (_, role) =>
    role === "generate" ? "## Proposal" : revision([{ issue_ref: "A:X-1", action: "rejected" }, { issue_ref: "B:Y-1", action: "accepted" }]));
  const a = scripted("a", () => review(5, [{ id: "X-1" }]));
  const b = scripted("b", () => review(5, [{ id: "Y-1" }]));
  const { store, done } = runLoop(cfg, new Map([["p", p], ["a", a], ["b", b]]));
  await done;

  const r2a = transcript(store).find((e) => e.provider === "a" && e.role === "review" && e.round === 2)!.prompt;
  assert.match(r2a, /X-1 \(major, other\): finding X-1/);
  assert.match(r2a, /You recommended: fix X-1/);
  assert.match(r2a, /Author: REJECTED — because/);
  assert.doesNotMatch(r2a, /Y-1/);
});

test("issues still unanswered after the follow-up are recorded and reported", async () => {
  const cfg = config({ maxRounds: 2 });
  const p = scripted("p", (prompt, role) =>
    role === "generate" ? "## Proposal"
    : prompt.includes("did not give a disposition") ? JSON.stringify({ dispositions: [{ issue_ref: "[a : x-1]", action: "partial", rationale: "r" }] })
    : revision([]));
  const a = scripted("a", () => review(5, [{ id: "X-1" }, { id: "X-2", severity: "blocker" }]));
  const b = scripted("b", () => review(5));
  const { done } = runLoop(cfg, new Map([["p", p], ["a", a], ["b", b]]));
  const state = await done;

  const r1 = state.rounds[0]!;
  assert.deepEqual(r1.revision!.dispositions.map((d) => d.issue_ref), ["A:X-1"], "loose ref normalised");
  assert.deepEqual(r1.undisposed, ["A:X-2"]);
  const report = renderReport(state);
  assert.match(report, /never answered[\s\S]*r1 a:X-2 \(blocker\) finding X-2/);
});

test("quota pause keeps finished reviews; resume only redoes the missing one", async () => {
  const cfg = config({ maxRounds: 1 });
  const p = scripted("p", () => "## Proposal");
  const a = scripted("a", () => review(9));
  const b = scripted("b", (_, __, call) => {
    if (call === 1) throw new QuotaError("b", "429");
    return review(9);
  });
  const providers = new Map([["p", p], ["a", a], ["b", b]]);
  const first = runLoop(cfg, providers);
  const paused = await first.done;
  assert.equal(paused.status, "paused_quota");
  assert.ok(paused.rounds[0]!.reviews.a);

  const reloaded = RunStore.load(cfg.runsDir, paused.id);
  const resumed = await new IdeationLoop(cfg, providers, reloaded.store, reloaded.state, { log: () => {} }).run();
  assert.equal(resumed.status, "converged");
  assert.equal(a.calls(), 1, "reviewer a was not asked again");
  assert.equal(b.calls(), 2);
});

test("stops on stagnation when the mean score doesn't improve", async () => {
  const cfg = config({ maxRounds: 10, stagnationRounds: 2, minDelta: 0.25 });
  const providers = buildProviders({
    p: { type: "mock", startScore: 5, step: 0, skipDispositions: false },
    a: { type: "mock", startScore: 5, step: 0, skipDispositions: false },
    b: { type: "mock", startScore: 5, step: 0, skipDispositions: false },
  }, ["p", "a", "b"], 10);
  const state = await runLoop(cfg, providers).done;
  assert.equal(state.status, "stagnated");
  assert.equal(state.rounds.length, 3);
});

test("stops at max rounds without convergence", async () => {
  const cfg = config({ maxRounds: 2, stagnationRounds: 5 });
  const p = scripted("p", (_, role) => (role === "generate" ? "## P" : revision([{ issue_ref: "A:X-1", action: "accepted" }])));
  const a = scripted("a", () => review(6, [{ id: "X-1" }]));
  const b = scripted("b", () => review(7));
  const state = await runLoop(cfg, new Map([["p", p], ["a", a], ["b", b]])).done;
  assert.equal(state.status, "max_rounds");
  assert.equal(state.rounds.length, 2);
});

test("report flags an unreviewed final proposal instead of claiming no open issues", async () => {
  const cfg = config({ maxRounds: 3 });
  const p = scripted("p", (_, role) => (role === "generate" ? "## P" : revision([{ issue_ref: "A:X-1", action: "accepted" }])));
  const a = scripted("a", (_, __, call) => {
    if (call === 2) throw new Error("network down");
    return review(5, [{ id: "X-1" }]);
  });
  const b = scripted("b", () => review(5));
  const state = await runLoop(cfg, new Map([["p", p], ["a", a], ["b", b]])).done;
  assert.equal(state.status, "failed");

  const report = renderReport(state);
  assert.match(report, /Open issues from the latest review \(round 1, 1\)/);
  assert.match(report, /\[a:X-1\]/);
  assert.match(report, /Final proposal \(round 2\)\n\n> This proposal has not been reviewed yet/);
});

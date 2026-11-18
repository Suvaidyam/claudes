import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Config } from "../src/config.js";
import { emptyPlan, initialMaxRounds, prepareContinue, resumeMaxRounds } from "../src/continue.js";
import { readLive } from "../src/live.js";
import { IdeationLoop } from "../src/loop.js";
import { buildProviders, type Provider } from "../src/providers.js";
import { RunStore } from "../src/store.js";
import { config, newRun, review, runLoop, scripted } from "./helpers.js";

const primary = () =>
  scripted("p", (prompt, role) =>
    role === "generate" ? "## Proposal" : JSON.stringify({ proposal: "## Revised", dispositions: [] }));
const reviewers = (score = 5) => [scripted("a", () => review(score)), scripted("b", () => review(score))];
const mapOf = (...ps: Provider[]) => new Map(ps.map((p) => [p.name, p]));

test("initialMaxRounds uses --rounds, else the config", () => {
  const cfg = config({ maxRounds: 4 });
  assert.equal(initialMaxRounds(cfg), 4);
  assert.equal(initialMaxRounds(cfg, "5"), 5);
  assert.throws(() => initialMaxRounds(cfg, "0"), /positive integer/);
});

test("resume uses state.maxRounds over the config", async () => {
  const cfg = config({ maxRounds: 3 });
  const run = newRun(cfg);
  run.state.maxRounds = 6;
  const proposals = Array.from({ length: 5 }, (_, i) => i + 1);
  run.state.rounds = proposals.map((round) => ({
    round, proposal: `p${round}`, reviews: {}, ...(round < 5 ? { revision: { proposal: `p${round + 1}`, dispositions: [] } } : {}),
  }));
  run.store.save(run.state);
  const [a, b] = reviewers();
  const final = await runLoop(cfg, mapOf(primary(), a!, b!), run).done;
  assert.equal(final.status, "max_rounds");
  assert.equal(final.rounds.length, 6);
});

test("resume --rounds overrides and updates state.maxRounds", () => {
  const cfg = config({ maxRounds: 3 });
  const state = newRun(cfg).state;
  assert.equal(resumeMaxRounds(state, cfg), 3, "legacy run falls back to the config");
  assert.equal(resumeMaxRounds(state, cfg, "8"), 8);
  assert.equal(state.maxRounds, 8);
  assert.equal(resumeMaxRounds(state, cfg), 8);
  assert.throws(() => resumeMaxRounds(state, cfg, "x"), /positive integer/);
});

test("continue records +N on the round", async () => {
  const cfg = config({ maxRounds: 2 });
  const [a, b] = reviewers();
  const first = await runLoop(cfg, mapOf(primary(), a!, b!)).done;
  const prepared = prepareContinue(cfg.runsDir, { ...emptyPlan(first.id), more: 2 });
  const last = prepared.state.rounds.at(-1)!;
  assert.deepEqual(last.continuedAt, { more: 2 });
  assert.equal(prepared.state.maxRounds, last.round + 2);
});

test("requestStop ends a slow run as stopped", async () => {
  const cfg = config();
  for (const p of Object.values(cfg.providers)) if (p.type === "mock") p.chunkDelayMs = 50;
  const providers = buildProviders(cfg.providers, ["p", "a", "b"], 30);
  const { store, state } = newRun(cfg);
  const loop = new IdeationLoop(cfg, providers, store, state, { log: () => {} });
  const done = loop.run();
  setTimeout(() => loop.requestStop("Stopped from the app"), 100);
  const final = await done;
  assert.equal(final.status, "stopped");
  assert.equal(final.statusDetail, "Stopped from the app");
  assert.equal(JSON.parse(readFileSync(join(store.dir, "state.json"), "utf8")).status, "stopped");
  const ends = readLive(store.dir, 0).events.filter((e) => e.t === "call_end");
  assert.equal(ends.at(-1)?.ok, false);
});

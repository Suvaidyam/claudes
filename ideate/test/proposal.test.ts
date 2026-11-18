/** `ideate run --proposal`: the owner's own text is round 1's proposal, so the writer isn't asked for one. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunState } from "../src/store.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = ["--import", "tsx", join(ROOT, "src", "cli.ts")];
/** An empty pool, so the CLI never reads the developer's real ~/.claudes. */
const ENV = { ...process.env, CLAUDES_BASE: mkdtempSync(join(tmpdir(), "ideate-proposal-base-")) };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ideate-proposal-"));
  const runsDir = join(dir, "runs");
  const cfgPath = join(dir, "config.json");
  const mock = { type: "mock" };
  writeFileSync(cfgPath, JSON.stringify({
    primary: "p", secondaries: ["a", "b"], loop: { maxRounds: 3 }, providers: { p: mock, a: mock, b: mock }, runsDir,
  }));
  const planPath = join(dir, "plan.md");
  writeFileSync(planPath, "# My plan\n\n1. Do the thing.\n");
  const ideate = (...args: string[]) =>
    spawnSync(process.execPath, [...CLI, ...args, "--config", cfgPath], { encoding: "utf8", cwd: ROOT, env: ENV });
  return { dir, runsDir, planPath, ideate };
}

const roles = (runsDir: string, id: string) =>
  readFileSync(join(runsDir, id, "raw", "transcript.jsonl"), "utf8").trim().split("\n")
    .map((l) => (JSON.parse(l) as { provider: string; role: string }));

test("run --proposal --rounds 1 reviews the given text and never calls the writer", () => {
  const { runsDir, planPath, ideate } = setup();
  const res = ideate("run", "--id", "r1", "--proposal", `@${planPath}`, "--rounds", "1");
  assert.equal(res.status, 2, res.stderr);

  const dir = join(runsDir, "r1");
  assert.equal(readFileSync(join(dir, "round-1", "proposal.md"), "utf8"), "# My plan\n\n1. Do the thing.\n");
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as RunState;
  assert.equal(state.status, "max_rounds");
  assert.equal(state.rounds.length, 1);
  assert.equal(state.rounds[0]!.proposal, "# My plan\n\n1. Do the thing.\n");
  assert.deepEqual(Object.keys(state.rounds[0]!.reviews).sort(), ["a", "b"]);
  assert.ok(state.brief.length > 0, "a default brief is filled in");
  assert.deepEqual(roles(runsDir, "r1").map((c) => c.provider).sort(), ["a", "b"]);
});

test("run --proposal with more rounds lets the writer revise the given text, not regenerate it", () => {
  const { runsDir, planPath, ideate } = setup();
  const res = ideate("run", "--id", "r2", "--brief", "Ship the thing", "--proposal", `@${planPath}`, "--rounds", "2");
  assert.ok(res.status === 0 || res.status === 2, res.stderr);
  const called = roles(runsDir, "r2").map((c) => c.role);
  assert.ok(!called.includes("generate"));
  assert.ok(called.includes("revise"));
});

test("--proposal is refused when empty or outside run", () => {
  const { dir, runsDir, ideate } = setup();
  const empty = join(dir, "empty.md");
  writeFileSync(empty, "  \n");
  const res = ideate("run", "--id", "r3", "--proposal", `@${empty}`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--proposal is empty/);
  assert.throws(() => readdirSync(join(runsDir, "r3")), "no run folder is left behind");

  const other = ideate("resume", "nope", "--proposal", "x");
  assert.equal(other.status, 1);
  assert.match(other.stderr, /--proposal is only for run/);
});

/** One data home: config.json and runs/ live in IDEATE_HOME (or ~/.claudes/shared/ideate), not in the cwd. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { ideateHome, resolveConfigPath } from "../src/home.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "ideate-home-"));

test("ideateHome honours IDEATE_HOME, then CLAUDES_BASE, then ~/.claudes", () => {
  assert.equal(ideateHome({ IDEATE_HOME: "/x/y" }), "/x/y");
  assert.equal(ideateHome({ CLAUDES_BASE: "/b" }), "/b/shared/ideate");
  assert.ok(ideateHome({}).endsWith("/.claudes/shared/ideate"));
});

test("a missing config is created from the example, once, with runs/ inside the home", () => {
  const home = join(tmp(), "my home");
  const env = { IDEATE_HOME: home };
  const first = resolveConfigPath(undefined, env);
  assert.equal(first.created, true);
  assert.equal(first.path, join(home, "config.json"));
  assert.equal(loadConfig(first.path).runsDir, join(home, "runs"));
  const bytes = readFileSync(first.path);
  const second = resolveConfigPath(undefined, env);
  assert.equal(second.created, false);
  assert.deepEqual(readFileSync(second.path), bytes);
});

test("an invalid config names its path and is left untouched", () => {
  const home = tmp();
  writeFileSync(join(home, "config.json"), "{not json");
  const { path } = resolveConfigPath(undefined, { IDEATE_HOME: home });
  assert.throws(() => loadConfig(path), (e: Error) => e.message.includes(path));
  assert.equal(readFileSync(path, "utf8"), "{not json");
});

test("a config that fails the schema names its path", () => {
  const home = tmp();
  const path = join(home, "config.json");
  writeFileSync(path, JSON.stringify({ primary: "p", secondaries: [], providers: {} }));
  assert.throws(() => loadConfig(path), (e: Error) => e.message.startsWith(`Config ${path} is invalid: `));
});

test("an absolute runsDir is kept", () => {
  const home = tmp();
  const mock = { type: "mock" };
  writeFileSync(join(home, "config.json"), JSON.stringify({
    primary: "p", secondaries: ["a"], providers: { p: mock, a: mock }, runsDir: "/abs/elsewhere",
  }));
  assert.equal(loadConfig(join(home, "config.json")).runsDir, "/abs/elsewhere");
});

test("an explicit --config that does not exist is an error", () => {
  assert.throws(() => resolveConfigPath("nope.json", {}), /Config not found/);
});

test("the CLI uses IDEATE_HOME and ignores a config.json in the cwd", () => {
  const home = tmp();
  const cwd = tmp();
  const mock = { type: "mock" };
  const cfg = (primary: string) => JSON.stringify({
    primary, secondaries: ["a", "b"], providers: { p: mock, q: mock, a: mock, b: mock },
  });
  writeFileSync(join(home, "config.json"), cfg("p"));
  writeFileSync(join(cwd, "config.json"), cfg("q"));
  const tsx = import.meta.resolve("tsx");
  const res = spawnSync(process.execPath, ["--import", tsx, join(ROOT, "src", "cli.ts"),
    "run", "--proposal", "x", "--rounds", "1", "--id", "t1"], {
    encoding: "utf8", cwd, env: { ...process.env, IDEATE_HOME: home, CLAUDES_BASE: tmp() },
  });
  assert.equal(res.status, 2, res.stderr);
  const state = JSON.parse(readFileSync(join(home, "runs", "t1", "state.json"), "utf8"));
  assert.equal(state.primary, "p");
  assert.deepEqual(readdirSync(cwd), ["config.json"]);
  assert.ok(!existsSync(join(cwd, "runs")));
});

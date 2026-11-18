import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listRuns } from "../src/ideas.js";
import type { RunState } from "../src/store.js";
import { isInterrupted, liveness, startHeartbeat } from "../src/worker.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** An empty pool, so the CLI never reads the developer's real ~/.claudes. */
const ENV = { ...process.env, CLAUDES_BASE: mkdtempSync(join(tmpdir(), "ideate-worker-base-")) };
const children = new Set<ChildProcess>();
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});

const tmp = () => mkdtempSync(join(tmpdir(), "ideate-worker-"));

function writeState(runsDir: string, id: string, status: RunState["status"]): string {
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const state: RunState = {
    id, createdAt: now, updatedAt: now, status, brief: "b", primary: "p", secondaries: ["a"], rounds: [],
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  return dir;
}

const writeWorker = (dir: string, pid: number, heartbeatAt = new Date().toISOString()) =>
  writeFileSync(join(dir, "worker.json"), JSON.stringify({ pid, startedAt: heartbeatAt, heartbeatAt, command: ["x"] }));

/** A mock config file in a temp dir, with its own runs dir. */
function mockConfig(mock: Record<string, unknown> = {}, maxRounds = 1): { path: string; runsDir: string } {
  const dir = tmp();
  const runsDir = join(dir, "runs");
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    primary: "p", secondaries: ["a"], loop: { maxRounds },
    providers: { p: { type: "mock", ...mock }, a: { type: "mock", ...mock } },
    runsDir,
  }));
  return { path, runsDir };
}

function cli(args: string[]): { child: ChildProcess; done: Promise<{ code: number | null; stderr: string }> } {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: ROOT, env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  child.stdout!.resume();
  const done = new Promise<{ code: number | null; stderr: string }>((res) =>
    child.on("close", (code) => { children.delete(child); res({ code, stderr }); }));
  return { child, done };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const readState = (runsDir: string, id: string): RunState => JSON.parse(readFileSync(join(runsDir, id, "state.json"), "utf8"));

test("heartbeat writes and removes worker.json", () => {
  const dir = tmp();
  const stop = startHeartbeat(dir, ["run", "--worker"]);
  const w = JSON.parse(readFileSync(join(dir, "worker.json"), "utf8"));
  assert.equal(w.pid, process.pid);
  assert.deepEqual(w.command, ["run", "--worker"]);
  assert.ok(w.startedAt && w.heartbeatAt);
  assert.equal(liveness(dir).active, true);
  stop();
  assert.equal(existsSync(join(dir, "worker.json")), false);
  assert.equal(liveness(dir).active, false);
});

test("liveness: dead pid is not active", () => {
  const dir = tmp();
  writeWorker(dir, 999999);
  assert.equal(liveness(dir).active, false);
});

test("liveness: a fresh heartbeat counts as active", () => {
  const dir = tmp();
  writeWorker(dir, process.pid);
  assert.equal(liveness(dir).active, true);
});

test("liveness: a stale heartbeat naming a reused (unrelated) pid is not active", () => {
  const dir = tmp();
  // This process started after the worker supposedly did, and its command line isn't the worker's.
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(join(dir, "worker.json"), JSON.stringify({ pid: process.pid, startedAt: old, heartbeatAt: old, command: ["run", "--id", "not-this-process-xyz"] }));
  assert.equal(liveness(dir).active, false);
});

test("liveness: a stale heartbeat whose pid is still the worker counts as active", () => {
  const dir = tmp();
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  // Our process started before `startedAt` (now): identity confirmed by start time.
  const startedAt = new Date().toISOString();
  writeFileSync(join(dir, "worker.json"), JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: old, command: ["x"] }));
  assert.deepEqual(liveness(dir), { active: true, pid: process.pid, heartbeatAt: old });
});

test("old runs are not active", () => {
  const runsDir = tmp();
  const done = writeState(runsDir, "old-done", "max_rounds");
  const state = readState(runsDir, "old-done");
  assert.equal(liveness(done).active, false);
  assert.equal(isInterrupted(state, done), false);
  const running = writeState(runsDir, "old-running", "running");
  assert.equal(isInterrupted(readState(runsDir, "old-running"), running), true);

  const rows = Object.fromEntries(listRuns(runsDir).map((r) => [r.id, r]));
  assert.equal(rows["old-done"]!.active, false);
  assert.equal(rows["old-done"]!.interrupted, false);
  assert.equal(rows["old-running"]!.active, false);
  assert.equal(rows["old-running"]!.interrupted, true);

  writeWorker(running, process.pid);
  const live = listRuns(runsDir).find((r) => r.id === "old-running")!;
  assert.equal(live.active, true);
  assert.equal(live.interrupted, false);
});

test("continue and resume refuse an active run", async () => {
  const { path, runsDir } = mockConfig();
  const dir = writeState(runsDir, "busy", "running");
  writeWorker(dir, process.pid);
  for (const cmd of ["continue", "resume"]) {
    const { code, stderr } = await cli([cmd, "busy", "--config", path]).done;
    assert.equal(code, 1, `${cmd}: ${stderr}`);
    assert.match(stderr, new RegExp(`Run busy is already running \\(pid ${process.pid}\\)`));
  }
});

test("run --id uses the given id and refuses duplicates", async () => {
  const { path, runsDir } = mockConfig();
  const first = await cli(["run", "--id", "test-1", "--brief", "x", "--config", path]).done;
  assert.notEqual(first.code, 1, first.stderr);
  assert.equal(existsSync(join(runsDir, "test-1", "state.json")), true);
  assert.equal(existsSync(join(runsDir, "test-1", "worker.json")), false);

  const again = await cli(["run", "--id", "test-1", "--brief", "x", "--config", path]).done;
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);

  // The app writes the brief into the run dir before spawning: a dir without state.json is fine.
  mkdirSync(join(runsDir, "test-3"), { recursive: true });
  writeFileSync(join(runsDir, "test-3", "brief.md"), "Brief from a file");
  const fromFile = await cli(["run", "--id", "test-3", "--brief", `@${join(runsDir, "test-3", "brief.md")}`, "--config", path]).done;
  assert.notEqual(fromFile.code, 1, fromFile.stderr);
  assert.equal(readState(runsDir, "test-3").brief, "Brief from a file");

  const bad = await cli(["run", "--id", "../escape", "--brief", "x", "--config", path]).done;
  assert.equal(bad.code, 1);
});

test("--worker forbids -i; --branch-id needs --from-round", async () => {
  const { path } = mockConfig();
  const w = await cli(["run", "--worker", "-i", "--brief", "x", "--config", path]).done;
  assert.equal(w.code, 1);
  assert.match(w.stderr, /--worker/);
  const b = await cli(["continue", "1", "--branch-id", "b-1", "--config", path]).done;
  assert.equal(b.code, 1);
  assert.match(b.stderr, /--branch-id/);
});

test("continue --branch-id names the branch", async () => {
  const { path, runsDir } = mockConfig();
  const base = await cli(["run", "--id", "base", "--brief", "x", "--config", path]).done;
  assert.notEqual(base.code, 1, base.stderr);
  const br = await cli(["continue", "base", "--from-round", "1", "--branch-id", "base-b1", "--more", "1", "--config", path]).done;
  assert.notEqual(br.code, 1, br.stderr);
  assert.deepEqual(readState(runsDir, "base-b1").parent, { id: "base", fromRound: 1 });
  const dup = await cli(["continue", "base", "--from-round", "1", "--branch-id", "base-b1", "--config", path]).done;
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /already exists/);
});

test("branching is allowed while the source idea is active", async () => {
  const { path, runsDir } = mockConfig();
  const base = await cli(["run", "--id", "busy", "--brief", "x", "--config", path]).done;
  assert.notEqual(base.code, 1, base.stderr);
  writeWorker(join(runsDir, "busy"), process.pid);
  const br = await cli(["continue", "busy", "--from-round", "1", "--branch-id", "busy-b1", "--more", "1", "--config", path]).done;
  assert.ok(br.code === 0 || br.code === 2, `exit ${br.code}: ${br.stderr}`);
  assert.deepEqual(readState(runsDir, "busy-b1").parent, { id: "busy", fromRound: 1 });
  const plain = await cli(["continue", "busy", "--config", path]).done;
  assert.equal(plain.code, 1);
  assert.match(plain.stderr, /already running/);
});

test("SIGTERM stops a worker as stopped", async () => {
  const { path, runsDir } = mockConfig({ chunkDelayMs: 200 }, 3);
  const { child, done } = cli(["run", "--id", "test-2", "--worker", "--brief", "x", "--config", path]);
  const workerFile = join(runsDir, "test-2", "worker.json");
  await waitFor(() => existsSync(workerFile), "worker.json");
  const pid = JSON.parse(readFileSync(workerFile, "utf8")).pid;
  assert.equal(pid, child.pid);
  process.kill(pid, "SIGTERM");
  const { code, stderr } = await done;
  assert.equal(code, 2, stderr);
  const state = readState(runsDir, "test-2");
  assert.equal(state.status, "stopped");
  assert.equal(state.statusDetail, "Stopped from the app");
  assert.equal(existsSync(workerFile), false);
});

test("a stopped worker kills an agent CLI that ignores SIGTERM before it exits", async () => {
  const dir = tmp();
  const runsDir = join(dir, "runs");
  const path = join(dir, "config.json");
  const pidFile = join(dir, "cli.pid");
  const stubborn = { type: "command", cmd: "sh", args: ["-c", `echo $$ > "${pidFile}"; trap "" TERM; while :; do sleep 0.1; done`] };
  writeFileSync(path, JSON.stringify({
    primary: "p", secondaries: ["a"], loop: { maxRounds: 1 },
    providers: { p: stubborn, a: { type: "mock" } }, runsDir,
  }));
  const { child, done } = cli(["run", "--id", "stubborn", "--worker", "--brief", "x", "--config", path]);
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the agent CLI to start");
  const cliPid = Number(readFileSync(pidFile, "utf8").trim());
  await new Promise((r) => setTimeout(r, 200)); // its trap is installed
  try {
    process.kill(child.pid!, "SIGTERM");
    const { code, stderr } = await done;
    assert.equal(code, 2, stderr);
    assert.equal(readState(runsDir, "stubborn").status, "stopped");
    assert.throws(() => process.kill(cliPid, 0), "the agent CLI died with the worker");
  } finally {
    try { process.kill(cliPid, "SIGKILL"); } catch { /* already gone */ }
  }
});

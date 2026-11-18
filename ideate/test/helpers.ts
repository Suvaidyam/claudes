import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../src/config.js";
import { IdeationLoop } from "../src/loop.js";
import type { Provider, Role } from "../src/providers.js";
import { RunStore, type RunState } from "../src/store.js";

export function config(loop: Record<string, unknown> = {}, secondaries = ["a", "b"]): Config {
  return Config.parse({
    primary: "p",
    secondaries,
    loop,
    providers: Object.fromEntries(["p", ...secondaries].map((n) => [n, { type: "mock" }])),
    runsDir: mkdtempSync(join(tmpdir(), "ideate-test-")),
  });
}

export function newRun(cfg: Config): { store: RunStore; state: RunState } {
  const id = RunStore.newId();
  const store = new RunStore(cfg.runsDir, id);
  const now = new Date().toISOString();
  const state: RunState = {
    id, createdAt: now, updatedAt: now, status: "running",
    brief: "Test brief", primary: cfg.primary, secondaries: cfg.secondaries, rounds: [],
  };
  store.save(state);
  return { store, state };
}

export function runLoop(cfg: Config, providers: Map<string, Provider>, run = newRun(cfg)) {
  const logs: string[] = [];
  const loop = new IdeationLoop(cfg, providers, run.store, run.state, { log: (m) => logs.push(m) });
  return { ...run, logs, done: loop.run() };
}

export function transcript(store: RunStore): { provider: string; role: Role; round: number; prompt: string }[] {
  return readFileSync(join(store.dir, "raw", "transcript.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

/** A provider driven by a function, for scripting exact behaviour per call. */
export function scripted(name: string, fn: (prompt: string, role: Role, call: number) => string | Promise<string>) {
  let call = 0;
  const p: Provider & { calls: () => number } = {
    name,
    complete: async (prompt, role) => fn(prompt, role, ++call),
    calls: () => call,
  };
  return p;
}

export function review(score: number, issues: { id: string; severity?: string }[] = []): string {
  return JSON.stringify({
    score, confidence: 0.8, summary: `score ${score}`, strengths: [],
    issues: issues.map((i) => ({
      id: i.id, severity: i.severity ?? "major", category: "other",
      finding: `finding ${i.id}`, recommendation: `fix ${i.id}`,
    })),
  });
}

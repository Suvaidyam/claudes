/**
 * Workers: every `run`/`continue`/`resume` process, wherever it was started, keeps a heartbeat
 * file in its run dir so the app (and other CLI processes) can tell an idea is being worked on.
 * An idea is active while `worker.json` names a process that is still alive and is still that
 * worker (a pid left in a stale worker.json can be reused by an unrelated process).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "./store.js";

export const HEARTBEAT_MS = 5000;

export interface WorkerInfo {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  command: string[];
}

const workerPath = (runDir: string) => join(runDir, "worker.json");

/** Writes worker.json now and every 5 s; the returned function stops and removes it. */
export function startHeartbeat(runDir: string, command: string[]): () => void {
  const path = workerPath(runDir);
  const startedAt = new Date().toISOString();
  const write = () => {
    const info: WorkerInfo = { pid: process.pid, startedAt, heartbeatAt: new Date().toISOString(), command };
    // Write-then-rename so a reader never sees a half-written file.
    writeFileSync(`${path}.tmp`, JSON.stringify(info, null, 2));
    renameSync(`${path}.tmp`, path);
  };
  write();
  const timer = setInterval(() => {
    try {
      write();
    } catch {
      /* run dir gone or disk trouble: the next beat tries again */
    }
  }, HEARTBEAT_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    try {
      // Only remove our own heartbeat, never one a later process wrote.
      if (readWorker(runDir)?.pid === process.pid) unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
}

function readWorker(runDir: string): WorkerInfo | undefined {
  try {
    const w = JSON.parse(readFileSync(workerPath(runDir), "utf8")) as WorkerInfo;
    return Number.isInteger(w?.pid) && w.pid > 0 ? w : undefined;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A heartbeat older than this no longer vouches for the pid on its own. */
export const STALE_MS = 30_000;

function ps(field: "lstart" | "command", pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Is `pid` still the process that started at or before `startedAt`? Checked by its start time
 * (`ps -o lstart`, 1 s resolution), else by its command line containing `command`. Unconfirmable
 * counts as no: a reused pid must never make an idea look busy or receive our SIGTERM.
 */
export function sameProcess(pid: number, startedAt: string, command: string[] = []): boolean {
  const lstart = ps("lstart", pid);
  const started = lstart ? Date.parse(lstart) : NaN;
  const ours = Date.parse(startedAt);
  if (Number.isFinite(started) && Number.isFinite(ours)) return started <= ours + 1000;
  const line = command.length ? ps("command", pid) : undefined;
  return !!line && line.includes(command.join(" "));
}

/**
 * Active ⇔ worker.json exists and its pid is alive. With a fresh heartbeat (≤ 30 s) that's enough;
 * with a stale one the pid must also still be our worker (see sameProcess).
 */
export function liveness(runDir: string): { active: boolean; pid?: number; heartbeatAt?: string } {
  if (!existsSync(workerPath(runDir))) return { active: false };
  const w = readWorker(runDir);
  if (!w || !pidAlive(w.pid)) return { active: false };
  const age = Date.now() - Date.parse(w.heartbeatAt);
  if (!(age <= STALE_MS) && !sameProcess(w.pid, w.startedAt, Array.isArray(w.command) ? w.command : [])) return { active: false };
  return { active: true, pid: w.pid, heartbeatAt: w.heartbeatAt };
}

/** Marked running, but no live process is working on it (crashed or killed). */
export const isInterrupted = (state: RunState, runDir: string): boolean =>
  state.status === "running" && !liveness(runDir).active;

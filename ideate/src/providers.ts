import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "./config.js";
import { envelopeError } from "./json.js";
import { createStreamParser } from "./streams.js";

export type Role = "generate" | "review" | "revise";

export interface Provider {
  name: string;
  complete(prompt: string, role: Role, opts?: CompleteOptions): Promise<string>;
}

export interface CompleteOptions {
  /** Called with each piece of text as the provider produces it. */
  onDelta?: (text: string) => void;
  /** Aborting kills the call; complete() rejects with StopError. */
  signal?: AbortSignal;
}

/** The call was cancelled through its AbortSignal. */
export class StopError extends Error {
  constructor(message = "stopped") {
    super(message);
  }
}

/** Quota / rate-limit exhaustion: the run is checkpointed and can be resumed later. */
export class QuotaError extends Error {
  constructor(public provider: string, detail: string) {
    super(`${provider}: quota or rate limit hit — ${detail.slice(0, 300)}`);
  }
}

const QUOTA_PATTERN =
  /\b429\b|rate[ _-]?limit|quota|resource[ _-]?exhausted|usage limit|too many requests|limit reached/i;

/**
 * Agentic CLIs (claude, gemini, codex) read files relative to their working directory.
 * Each call gets its own fresh, empty directory, deleted afterwards, so a CLI never sees the repo
 * you launched from or anything another call left behind. This is not a sandbox: a CLI that has
 * file or shell tools can still read absolute paths. Disable tools in the provider's args too.
 */
function scratchDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ideate-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ARG_PROMPT_LIMIT = 120 * 1024;
const KILL_GRACE_MS = 5000;

/** Agent CLIs still running, each with how to terminate it and when it has closed. */
const inFlight = new Map<ChildProcess, { terminate: () => void; closed: Promise<void> }>();

/**
 * Terminates every agent CLI still running and waits until they have exited: SIGTERM, then
 * SIGKILL after `graceMs`. A stopping worker calls this before it exits, so a CLI that ignores
 * SIGTERM can't outlive it (and keep spending).
 */
export async function waitForChildren(graceMs = KILL_GRACE_MS): Promise<void> {
  if (!inFlight.size) return;
  for (const { terminate } of inFlight.values()) terminate();
  const closing = Promise.all([...inFlight.values()].map((c) => c.closed));
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((r) => { timer = setTimeout(r, graceMs); });
  await Promise.race([closing, grace]);
  clearTimeout(timer);
  for (const child of inFlight.keys()) child.kill("SIGKILL");
  const cap = new Promise<void>((r) => { timer = setTimeout(r, 1000); });
  await Promise.race([Promise.all([...inFlight.values()].map((c) => c.closed)), cap]);
  clearTimeout(timer);
}

/** Last resort before a forced exit: SIGKILL every agent CLI still running. */
export function killChildren(): void {
  for (const child of inFlight.keys()) child.kill("SIGKILL");
}

class CommandProvider implements Provider {
  constructor(
    public name: string,
    private cfg: Extract<ProviderConfig, { type: "command" }>,
    private defaultTimeoutSec: number,
  ) {}

  complete(prompt: string, _role?: Role, opts: CompleteOptions = {}): Promise<string> {
    const { cmd, input, env } = this.cfg;
    const args = this.cfg.args.map((a) => (input === "arg" ? a.replaceAll("{prompt}", prompt) : a));
    const timeoutMs = (this.cfg.timeoutSec ?? this.defaultTimeoutSec) * 1000;
    // Linux caps a single argv string at 128 KiB (MAX_ARG_STRLEN); fail clearly instead of with E2BIG.
    if (input === "arg" && Buffer.byteLength(prompt) > ARG_PROMPT_LIMIT) {
      return Promise.reject(new Error(
        `${this.name}: prompt is ${Math.round(Buffer.byteLength(prompt) / 1024)} KiB, too long to pass as an argument. ` +
        `Set "input": "stdin" for this provider in config.json.`,
      ));
    }

    if (opts.signal?.aborted) return Promise.reject(new StopError());
    const scratch = scratchDir();
    return new Promise<string>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: scratch.dir,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      let killTimer: NodeJS.Timeout | undefined;
      let stopped = false;
      const parser = this.cfg.stream && opts.onDelta ? createStreamParser(this.cfg.stream) : undefined;
      const emit = (texts: string[]) => { for (const t of texts) opts.onDelta!(t); };
      let terminating = false;
      const terminate = () => {
        if (terminating) return;
        terminating = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };
      inFlight.set(child, {
        terminate,
        closed: new Promise<void>((done) => {
          const gone = () => { inFlight.delete(child); done(); };
          child.once("close", gone);
          child.once("error", gone);
        }),
      });
      const onAbort = () => {
        stopped = true;
        clearTimeout(timer);
        terminate();
        reject(new StopError());
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        // Agentic CLIs can ignore SIGTERM while a tool runs; terminate() escalates to SIGKILL.
        // `stopped` also silences deltas (including the close-time flush) after we reject.
        stopped = true;
        terminate();
        reject(new Error(`${this.name}: timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        out += d;
        if (parser && !stopped) emit(parser.push(d));
      });
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(new Error(`${this.name}: failed to start "${cmd}" — ${e.message}. Is it installed and on PATH?`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (stopped) return;
        if (parser) emit(parser.flush());
        // Exit 0 isn't enough: some CLIs report quota and API errors inside a JSON envelope.
        const inBand = code === 0 ? envelopeError(out) : undefined;
        if (code === 0 && out.trim() && !inBand) return resolve(out);
        const detail = (inBand ? `${inBand}\n${err}` : `${err}\n${out}`).trim();
        if (QUOTA_PATTERN.test(detail)) return reject(new QuotaError(this.name, detail));
        reject(new Error(`${this.name}: ${inBand ? "reported an error" : `exit ${code}`} — ${detail.slice(0, 500)}`));
      });

      // A CLI that exits without reading stdin causes EPIPE; the exit code is reported via "close" instead.
      child.stdin.on("error", () => {});
      if (input === "stdin") child.stdin.write(prompt);
      else if (input === "stream-json") {
        child.stdin.write(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n");
      }
      child.stdin.end();
    }).finally(scratch.cleanup);
  }
}

/** Deterministic offline provider for testing the loop without spending quota. */
class MockProvider implements Provider {
  private calls = 0;
  private reviews = 0;
  constructor(public name: string, private cfg: Extract<ProviderConfig, { type: "mock" }>) {}

  async complete(prompt: string, role: Role, opts: CompleteOptions = {}): Promise<string> {
    const out = this.produce(prompt, role);
    if (!this.cfg.chunkDelayMs) return out;
    return this.stream(out, opts);
  }

  private async stream(out: string, opts: CompleteOptions): Promise<string> {
    for (let i = 0; i < out.length; i += 40) {
      if (opts.signal?.aborted) throw new StopError();
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(t); opts.signal?.removeEventListener("abort", done); resolve(); };
        const t = setTimeout(done, this.cfg.chunkDelayMs);
        opts.signal?.addEventListener("abort", done, { once: true });
      });
      if (opts.signal?.aborted) throw new StopError();
      opts.onDelta?.(out.slice(i, i + 40));
    }
    return out;
  }

  private produce(prompt: string, role: Role): string {
    this.calls++;
    if (this.cfg.failOnCall && this.calls === this.cfg.failOnCall) {
      throw new QuotaError(this.name, "simulated 429 RESOURCE_EXHAUSTED");
    }
    if (role === "generate") {
      return `## Proposal (mock by ${this.name})\n\n- Modular monolith, Postgres, outbox -> event bus\n- Offline-first client with CRDT-free last-writer-wins + server conflict queue`;
    }
    if (role === "review") {
      const score = Math.min(10, this.cfg.startScore + this.reviews++ * this.cfg.step);
      const blocker = score < 7;
      return "Here is my review:\n```json\n" + JSON.stringify({
        score,
        confidence: 0.7,
        summary: `Mock review from ${this.name} at score ${score}.`,
        strengths: ["Clear service boundaries"],
        issues: [
          ...(blocker
            ? [{ id: "SEC-1", severity: "blocker", category: "security", finding: "No device key rotation", recommendation: "Add per-device keys with rotation" }]
            : []),
          { id: "OPS-1", severity: "minor", category: "ops", finding: "No sync backlog metric", recommendation: "Expose per-facility sync lag" },
        ],
      }) + "\n```";
    }
    const round = (prompt.match(/ROUND (\d+)/)?.[1]) ?? "?";
    // Answer every "[A:SEC-1]"-style ref in the prompt, except that with skipDispositions the first
    // revision answers none, so the follow-up request for missing dispositions gets exercised.
    const refs = [...new Set([...prompt.matchAll(/\[([A-Z]+:[A-Z0-9]+(?:-\d+)?)\]/g)].map((m) => m[1]!))];
    const isFollowUp = prompt.includes("did not give a disposition");
    const answered = this.cfg.skipDispositions && !isFollowUp ? [] : refs;
    return JSON.stringify({
      proposal: `## Proposal (mock revision, round ${round})\n\n- Added per-device key rotation\n- Added sync-lag metrics`,
      dispositions: answered.map((ref) => ({
        issue_ref: ref,
        action: ref.includes("OPS") ? "rejected" : "accepted",
        rationale: ref.includes("OPS") ? "Sync lag is already covered by the facility dashboard" : "Valid gap",
      })),
    });
  }
}

export function buildProviders(
  cfgs: Record<string, ProviderConfig>,
  names: string[],
  timeoutSec: number,
): Map<string, Provider> {
  const map = new Map<string, Provider>();
  for (const name of names) {
    const c = cfgs[name]!;
    map.set(name, c.type === "mock" ? new MockProvider(name, c) : new CommandProvider(name, c, timeoutSec));
  }
  return map;
}

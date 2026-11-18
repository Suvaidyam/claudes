import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Issue, Review, Revision } from "./schema.js";

export type RunStatus = "running" | "paused_quota" | "converged" | "max_rounds" | "stagnated" | "stopped" | "failed";

export interface RoundRecord {
  round: number;
  proposal: string;
  reviews: Record<string, Review>; // keyed by provider name
  meanScore?: number;
  minScore?: number;
  blockers?: number;
  humanFeedback?: string;
  revision?: Revision;
  /** Review issues ("<label>:<id>") the primary never gave a disposition, even after a follow-up. */
  undisposed?: string[];
  /** Past issues the owner reopened for this round's revision; shown to the primary as "OWNER:<n>". */
  reopened?: Reopened[];
  /** Set on the round where `ideate continue` picked the run up; stagnation counts from here. */
  continuedAt?: true | { more: number };
  /** The human gate already ran for this round (set by the chat UI flow). */
  gateDone?: true;
}

/** A case the design must handle, added by the owner. Ids are never reused; removed ones stay for history. */
export interface Scenario {
  id: string;
  text: string;
  addedRound: number;
  editedRound?: number;
  removedRound?: number;
}

/** A past issue brought back by the owner. `ref` is "r<round>:<reviewer>:<issueId>". */
export interface Reopened {
  ref: string;
  issue: Issue;
}

export interface RunState {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  statusDetail?: string;
  brief: string;
  context?: string;
  primary: string;
  secondaries: string[];
  rounds: RoundRecord[];
  title?: string;
  scenarios?: Scenario[];
  /** Set when this run was branched from another run's round. */
  parent?: { id: string; fromRound: number };
  /** This run's own round limit; overrides config.loop.maxRounds. Absent on legacy runs. */
  maxRounds?: number;
  /** Byte offset in inbox.jsonl up to which every item has been applied to the run. */
  inboxConsumed?: number;
  /** `ts` of `more` items past `inboxConsumed` already applied early (before a stop check). */
  inboxMoreApplied?: string[];
}

export class RunStore {
  readonly dir: string;
  constructor(runsDir: string, readonly id: string) {
    this.dir = join(runsDir, id);
    mkdirSync(join(this.dir, "raw"), { recursive: true });
  }

  static newId(): string {
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    return `${ts}-${randomBytes(2).toString("hex")}`;
  }

  /** For ids given on the command line: a safe folder name with no run in it yet. */
  static assertNewId(runsDir: string, id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) {
      throw new Error(`Run id "${id}" must be letters, digits, ".", "_" or "-" (starting with a letter or digit)`);
    }
    // Only state.json makes it a run: the app writes brief.md into the folder before starting it.
    if (existsSync(join(runsDir, id, "state.json"))) throw new Error(`Run ${id} already exists`);
  }

  static load(runsDir: string, id: string): { store: RunStore; state: RunState } {
    const path = join(runsDir, id, "state.json");
    if (!existsSync(path)) throw new Error(`No run state at ${path}`);
    return { store: new RunStore(runsDir, id), state: JSON.parse(readFileSync(path, "utf8")) };
  }

  /** Write-then-rename, so a crash mid-write can't corrupt the checkpoint that resume depends on. */
  save(state: RunState): void {
    state.updatedAt = new Date().toISOString();
    const path = join(this.dir, "state.json");
    writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  writeArtifact(rel: string, content: string): void {
    const path = join(this.dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }

  /** Full prompt/response transcript for audit and debugging. */
  logCall(provider: string, role: string, round: number, prompt: string, output: string): void {
    const entry = { ts: new Date().toISOString(), provider, role, round, prompt, output };
    appendFileSync(join(this.dir, "raw", "transcript.jsonl"), JSON.stringify(entry) + "\n");
  }
}

/**
 * Managing ideas: each run is one idea. These are pure functions over RunState (plus one
 * directory read) so the CLI, the interactive wizard and later the web UI share them.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Disposition, Issue } from "./schema.js";
import type { Reopened, RoundRecord, RunState, RunStatus, Scenario } from "./store.js";
import { liveness } from "./worker.js";

export const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Disposition label for owner-reopened issues, e.g. "OWNER:1". Not a letter, so it can't clash with a reviewer. */
export const OWNER_LABEL = "OWNER";

export const labelOf = (state: RunState, reviewer: string): string | undefined =>
  LABELS[state.secondaries.indexOf(reviewer)];

export function ideaTitle(state: RunState): string {
  const t = state.title?.trim() || state.brief.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) || state.id;
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

export const activeScenarios = (state: RunState): Scenario[] =>
  (state.scenarios ?? []).filter((s) => s.removedRound === undefined);

export const lastReviewed = (state: RunState): RoundRecord | undefined =>
  [...state.rounds].reverse().find((r) => r.meanScore !== undefined);

export interface RunSummary {
  /** Stable row number: runs are numbered in creation order, so continuing one doesn't renumber the list. */
  num: number;
  id: string;
  title: string;
  status: RunStatus;
  rounds: number;
  lastMean?: number;
  lastBlockers?: number;
  scenarios: number;
  createdAt: string;
  updatedAt: string;
  parent?: { id: string; fromRound: number };
  /** 0 for top-level ideas, 1 for branches listed under their parent. */
  depth: number;
  /** A live process is working on it right now (see worker.ts). */
  active: boolean;
  /** Marked running, but no live process is working on it. */
  interrupted: boolean;
}

/** `runDir` is where to look for a worker heartbeat; without it the run counts as not active. */
export function summarize(state: RunState, depth = 0, num = 0, runDir?: string): RunSummary {
  const lr = lastReviewed(state);
  const active = runDir !== undefined && liveness(runDir).active;
  return {
    num, id: state.id, title: ideaTitle(state), status: state.status, rounds: state.rounds.length,
    lastMean: lr?.meanScore, lastBlockers: lr?.blockers, scenarios: activeScenarios(state).length,
    createdAt: state.createdAt, updatedAt: state.updatedAt, parent: state.parent, depth,
    active, interrupted: state.status === "running" && !active,
  };
}

/**
 * Every readable run, newest idea first, with branches right under their parent. Row numbers
 * follow creation order and don't change when a run is continued.
 */
export function listRuns(runsDir: string): RunSummary[] {
  if (!existsSync(runsDir)) return [];
  const states: RunState[] = [];
  const dirOf = new Map<string, string>();
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const s = JSON.parse(readFileSync(join(runsDir, entry.name, "state.json"), "utf8")) as RunState;
      if (s && typeof s.id === "string" && Array.isArray(s.rounds) && typeof s.brief === "string") {
        states.push(s);
        dirOf.set(s.id, join(runsDir, entry.name));
      }
    } catch {
      /* not a run, or a broken one: skip */
    }
  }
  const byCreation = [...states].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const numOf = new Map(byCreation.map((s, i) => [s.id, i + 1]));
  const newest = (a: RunState, b: RunState) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  const ids = new Set(states.map((s) => s.id));
  const childrenOf = (id: string) => states.filter((s) => s.parent?.id === id).sort(newest);
  const out: RunSummary[] = [];
  const add = (s: RunState, depth: number) => {
    out.push(summarize(s, depth, numOf.get(s.id)!, dirOf.get(s.id)));
    for (const c of childrenOf(s.id)) add(c, depth + 1);
  };
  for (const s of states.filter((x) => !x.parent || !ids.has(x.parent.id)).sort(newest)) add(s, 0);
  return out;
}

/** "3" -> the run numbered 3 in `ideate list`; otherwise an exact run ID. */
export function resolveRunRef(runs: RunSummary[], ref: string): RunSummary {
  if (/^\d{1,4}$/.test(ref)) {
    const row = runs.find((r) => r.num === Number(ref));
    if (!row) throw new Error(`No idea #${ref}; \`ideate list\` shows ${runs.length}`);
    return row;
  }
  const hit = runs.find((r) => r.id === ref);
  if (!hit) throw new Error(`No run with ID "${ref}". Use \`ideate list\` to see your ideas.`);
  return hit;
}

export interface PastIssue {
  ref: string;
  round: number;
  reviewer: string;
  issue: Issue;
  disposition?: Disposition;
  /** The same reviewer raised the same id in the latest reviewed round. */
  stillRaised: boolean;
  /** Short human label: open / accepted / partial / rejected / unanswered, plus "· raised again". */
  outcome: string;
}

export function pastIssues(state: RunState): PastIssue[] {
  const latest = lastReviewed(state);
  const out: PastIssue[] = [];
  for (const r of state.rounds) {
    for (const reviewer of state.secondaries) {
      for (const issue of r.reviews[reviewer]?.issues ?? []) {
        const label = labelOf(state, reviewer);
        const disposition = r.revision?.dispositions.find((d) => d.issue_ref === `${label}:${issue.id}`);
        const isLatest = r.round === latest?.round;
        const stillRaised = !isLatest && !!latest?.reviews[reviewer]?.issues.some((i) => i.id === issue.id);
        const outcome = isLatest
          ? "open"
          : `${disposition?.action ?? "unanswered"}${stillRaised ? " · raised again" : ""}`;
        out.push({ ref: `r${r.round}:${reviewer}:${issue.id}`, round: r.round, reviewer, issue, disposition, stillRaised, outcome });
      }
    }
  }
  return out;
}

export function findIssue(state: RunState, ref: string): Reopened {
  const hit = pastIssues(state).find((p) => p.ref.toLowerCase() === ref.trim().toLowerCase());
  if (!hit) throw new Error(`No issue "${ref}" in run ${state.id}. Use \`ideate issues ${state.id}\` to see refs.`);
  return { ref: hit.ref, issue: hit.issue };
}

export function addScenario(state: RunState, round: number, text: string): Scenario {
  const t = text.trim();
  if (!t) throw new Error("A scenario can't be empty");
  const list = (state.scenarios ??= []);
  const next = Math.max(0, ...list.map((s) => Number(s.id.slice(1)) || 0)) + 1;
  const sc: Scenario = { id: `S${next}`, text: t, addedRound: round };
  list.push(sc);
  return sc;
}

function activeScenario(state: RunState, id: string): Scenario {
  const sc = activeScenarios(state).find((s) => s.id.toLowerCase() === id.trim().toLowerCase());
  if (!sc) throw new Error(`No active scenario "${id}"`);
  return sc;
}

export function editScenario(state: RunState, round: number, id: string, text: string): Scenario {
  const sc = activeScenario(state, id);
  if (!text.trim()) throw new Error("A scenario can't be empty");
  sc.text = text.trim();
  sc.editedRound = round;
  return sc;
}

export function removeScenario(state: RunState, round: number, id: string): Scenario {
  const sc = activeScenario(state, id);
  sc.removedRound = round;
  return sc;
}

/** Scenarios added or edited at `round` count as new for prompts built in that round. */
export const isNewScenario = (s: Scenario, round: number) => s.addedRound === round || s.editedRound === round;

/**
 * A new run that restarts from `fromRound`'s proposal and reviews: rounds after it are dropped,
 * and round `fromRound` loses its revision so it gets revised again. Scenarios added before
 * `fromRound` carry over with their current text. The source state is not modified.
 */
export function branchRun(src: RunState, fromRound: number, newId: string, now = new Date().toISOString()): RunState {
  const lastRound = src.rounds.length;
  if (!Number.isInteger(fromRound) || fromRound < 1 || fromRound > lastRound) {
    throw new Error(`--from-round must be between 1 and ${lastRound}`);
  }
  if (src.rounds[fromRound - 1]!.meanScore === undefined) {
    throw new Error(`Round ${fromRound} was never reviewed, so there is nothing to branch from`);
  }
  const copy = structuredClone(src);
  const rounds = copy.rounds.slice(0, fromRound);
  const last = rounds[rounds.length - 1]!;
  delete last.revision;
  delete last.undisposed;
  delete last.humanFeedback;
  delete last.reopened;
  delete last.continuedAt;
  delete last.gateDone;
  // A branch starts with its own empty inbox; the parent's unconsumed items stay on the parent.
  delete copy.inboxConsumed;
  delete copy.inboxMoreApplied;
  return {
    ...copy,
    id: newId,
    createdAt: now,
    updatedAt: now,
    status: "running",
    statusDetail: undefined,
    rounds,
    scenarios: (copy.scenarios ?? [])
      .filter((s) => s.addedRound < fromRound && (s.removedRound === undefined || s.removedRound >= fromRound))
      .map(({ removedRound: _r, ...s }) => s),
    parent: { id: src.id, fromRound },
  };
}

/**
 * Marks the run's last round as the point where `ideate continue` resumes it, with the owner's
 * reopened issues and note for the next revision.
 */
export function applyContinue(
  state: RunState,
  opts: { reopen: Reopened[]; note?: string; more: number; beforeNote?: (cur: RoundRecord) => void },
): RoundRecord {
  const cur = state.rounds[state.rounds.length - 1];
  if (!cur) throw new Error("This run has no rounds yet; use `ideate resume` instead");
  if (cur.revision && (opts.reopen.length || opts.note)) {
    throw new Error(`Round ${cur.round} was already revised before the run stopped. Run \`ideate resume ${state.id}\` first.`);
  }
  cur.continuedAt = { more: opts.more };
  state.maxRounds = cur.round + opts.more;
  // Queued `more` items applied early to the old limit (e.g. before a stop rule ended the run) were
  // never consumed: forget them so the loop applies them again on top of the new limit.
  delete state.inboxMoreApplied;
  if (opts.reopen.length) cur.reopened = [...(cur.reopened ?? []), ...opts.reopen];
  // E.g. the owner's earlier queued input, which belongs before this note.
  opts.beforeNote?.(cur);
  const note = opts.note?.trim();
  // Append: the round may already carry feedback (inbox notes consumed before a failed revision).
  if (note) cur.humanFeedback = cur.humanFeedback ? `${cur.humanFeedback}\n\n${note}` : note;
  return cur;
}

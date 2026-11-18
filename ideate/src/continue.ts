/**
 * `ideate continue`: apply the owner's changes to an idea (optionally on a new branch) and hand
 * the run back to the loop. No prompting here: the flags and the interactive wizard both build a
 * ContinuePlan and call prepareContinue.
 */
import {
  addScenario, applyContinue, branchRun, editScenario, findIssue, ideaTitle, removeScenario,
} from "./ideas.js";
import type { Config } from "./config.js";
import { applyInbox, readInbox } from "./inbox.js";
import { RunStore, type Reopened, type RoundRecord, type RunState } from "./store.js";

export interface ContinuePlan {
  runId: string;
  /** Branch into a new run starting from this round; the original run is left untouched. */
  fromRound?: number;
  /** Id for the new branch (with fromRound); generated when absent. */
  branchId?: string;
  addScenarios: string[];
  editScenarios: { id: string; text: string }[];
  removeScenarios: string[];
  /** Past issue refs, "r<round>:<reviewer>:<issueId>", resolved against the original run. */
  reopen: string[];
  note?: string;
  /** Extra review rounds to run. */
  more: number;
}

export const emptyPlan = (runId: string): ContinuePlan => ({
  runId, addScenarios: [], editScenarios: [], removeScenarios: [], reopen: [], more: 2,
});

export interface PreparedContinue {
  store: RunStore;
  state: RunState;
  /** Round the loop picks up from; state.maxRounds is this + plan.more. */
  fromRound: number;
  /** Human-readable lines describing what changed, for the terminal. */
  changes: string[];
}

export function prepareContinue(runsDir: string, plan: ContinuePlan, newId = RunStore.newId): PreparedContinue {
  if (!Number.isInteger(plan.more) || plan.more < 1) throw new Error(`--more must be a positive integer, got ${plan.more}`);
  if (plan.branchId !== undefined) {
    if (plan.fromRound === undefined) throw new Error("--branch-id needs --from-round");
    RunStore.assertNewId(runsDir, plan.branchId);
  }
  const src = RunStore.load(runsDir, plan.runId);
  const changes: string[] = [];

  // Resolve reopened issues against the original run, before any branching, so issues from
  // rounds after the branch point can still be brought into the branch.
  const reopen: Reopened[] = [];
  for (const ref of plan.reopen) {
    const hit = findIssue(src.state, ref);
    if (!reopen.some((r) => r.ref === hit.ref)) reopen.push(hit);
  }

  // All changes are applied in memory first; nothing touches disk until they have all succeeded,
  // so a bad scenario id can't leave a half-made branch folder behind.
  const branching = plan.fromRound !== undefined;
  const state = branching ? branchRun(src.state, plan.fromRound!, plan.branchId ?? newId()) : src.state;
  if (branching) changes.push(`Branched ${src.state.id} at round ${plan.fromRound} → new run ${state.id}`);

  const round = state.rounds.length;
  for (const id of plan.removeScenarios) changes.push(`Removed ${removeScenario(state, round, id).id}`);
  for (const { id, text } of plan.editScenarios) changes.push(`Edited ${editScenario(state, round, id, text).id}`);
  for (const text of plan.addScenarios) {
    const sc = addScenario(state, round, text);
    changes.push(`Added ${sc.id}: ${oneLine(sc.text)}`);
  }
  for (const r of reopen) changes.push(`Reopened ${r.ref}: ${oneLine(r.issue.finding)}`);
  if (plan.note?.trim()) changes.push(`Note for the next revision: ${oneLine(plan.note)}`);

  // The idea's own queue was sent before this message: apply it first (on top of the new round
  // limit), so older notes come before the new one. A branch starts with an empty inbox.
  const drainQueue = (cur: RoundRecord) => {
    if (branching || cur.revision) return;
    const from = state.inboxConsumed ?? 0;
    const { items, offset } = readInbox(src.store.dir, from);
    for (const line of applyInbox(state, cur, items)) changes.push(`Queued earlier: ${line}`);
    if (offset !== from) state.inboxConsumed = offset;
  };
  applyContinue(state, { reopen, note: plan.note, more: plan.more, beforeNote: drainQueue });
  const store = branching ? new RunStore(runsDir, state.id) : src.store;
  if (branching) writeRoundArtifacts(store, state);
  store.save(state);
  changes.unshift(`Continuing "${ideaTitle(state)}" from round ${round}, up to ${plan.more} more round(s)`);
  return { store, state, fromRound: round, changes };
}

/** A branch gets the same per-round files as a normal run, so its folder reads the same. */
function writeRoundArtifacts(store: RunStore, state: RunState): void {
  for (const r of state.rounds) {
    store.writeArtifact(`round-${r.round}/proposal.md`, r.proposal);
    for (const [name, review] of Object.entries(r.reviews)) {
      store.writeArtifact(`round-${r.round}/review-${name}.json`, JSON.stringify(review, null, 2));
    }
    if (r.revision) store.writeArtifact(`round-${r.round}/revision.json`, JSON.stringify(r.revision, null, 2));
  }
}

const oneLine = (t: string, n = 100) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function parseRounds(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--rounds must be a positive integer, got "${value}"`);
  return n;
}

/** Round limit for a new run: --rounds, else the config's. */
export function initialMaxRounds(cfg: Config, override?: string): number {
  return override === undefined ? cfg.loop.maxRounds : parseRounds(override);
}

/** Round limit on resume: --rounds (stored on the run), else the run's own, else the config's (legacy runs). */
export function resumeMaxRounds(state: RunState, cfg: Config, override?: string): number {
  if (override !== undefined) state.maxRounds = parseRounds(override);
  return state.maxRounds ?? cfg.loop.maxRounds;
}

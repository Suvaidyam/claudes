/**
 * Interactive `ideate continue`: arrow-key menus that build a ContinuePlan.
 * Esc or Ctrl-C at any step cancels without changing anything.
 */
import { emitKeypressEvents } from "node:readline";
import { emptyPlan, type ContinuePlan } from "./continue.js";
import { activeScenarios, branchRun, ideaTitle, pastIssues, type RunSummary } from "./ideas.js";
import { RunStore, type RunState } from "./store.js";

type Prompts = typeof import("@inquirer/prompts");

class Cancelled extends Error {}

/** Runs one prompt; Esc aborts it. Ctrl-C and Esc both become Cancelled. */
async function ask<T>(run: (ctx: { signal: AbortSignal }) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const onKey = (_: unknown, key?: { name?: string }) => {
    if (key?.name === "escape") ac.abort();
  };
  emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", onKey);
  try {
    return await run({ signal: ac.signal });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "ExitPromptError" || name === "AbortPromptError" || ac.signal.aborted) throw new Cancelled();
    throw e;
  } finally {
    process.stdin.off("keypress", onKey);
  }
}

export function formatRow(r: RunSummary): string {
  const score = r.lastMean === undefined ? "—" : `${r.lastMean.toFixed(1)} · ${r.lastBlockers} blk`;
  const title = r.depth ? `${"  ".repeat(r.depth - 1)}↳ r${r.parent!.fromRound}: ${r.title}` : r.title;
  return `${String(r.num).padStart(2)}  ${title.padEnd(48).slice(0, 48)}  ${r.status.padEnd(12)} r${r.rounds}  ${score.padEnd(11)}  ${r.scenarios} scen.`;
}

/** Returns undefined when the user cancels. */
export async function runWizard(runs: RunSummary[], runsDir: string): Promise<ContinuePlan | undefined> {
  if (!runs.length) throw new Error("No ideas yet. Start one with `ideate run --brief ...`.");
  const p: Prompts = await import("@inquirer/prompts");
  console.error("Esc or Ctrl-C cancels at any step; nothing changes until you confirm.\n");
  try {
    return await steps(p, runs, runsDir);
  } catch (e) {
    if (e instanceof Cancelled) {
      console.error("Cancelled. Nothing was changed.");
      return undefined;
    }
    throw e;
  }
}

async function steps(p: Prompts, runs: RunSummary[], runsDir: string): Promise<ContinuePlan | undefined> {
  // 1. Pick the idea
  const runId = await ask((ctx) => p.select({
    message: "Which idea?",
    pageSize: 12,
    choices: runs.map((r) => ({ name: formatRow(r), value: r.id, description: `${r.id} · updated ${r.updatedAt.slice(0, 16).replace("T", " ")}` })),
  }, ctx));
  const { state } = RunStore.load(runsDir, runId);
  const plan = emptyPlan(runId);

  // 2. Latest round, or branch from an earlier one
  const reviewed = state.rounds.filter((r) => r.meanScore !== undefined);
  const last = state.rounds[state.rounds.length - 1]!;
  const from = await ask((ctx) => p.select<number>({
    message: "Continue from where?",
    choices: [
      { name: `Latest: round ${last.round}${last.meanScore !== undefined ? ` (mean ${last.meanScore.toFixed(1)}, ${last.blockers} blockers)` : ""}`, value: 0 },
      ...reviewed.map((r) => ({
        name: `Branch from round ${r.round} (mean ${r.meanScore!.toFixed(1)}, ${r.blockers} blockers) as a new run`,
        value: r.round,
        description: "The original run stays as it is.",
      })),
    ],
  }, ctx));
  if (from) plan.fromRound = from;

  // 3. Scenarios
  await editScenarios(p, plan, from ? branchRun(state, from, "preview").scenarios ?? [] : activeScenarios(state));

  // 4. Reopen past issues (from the whole original run, even after a branch point)
  const issues = pastIssues(state);
  if (issues.length) {
    const choices: (InstanceType<Prompts["Separator"]> | { name: string; value: string; description: string })[] = [];
    for (const r of state.rounds) {
      const inRound = issues.filter((x) => x.round === r.round);
      if (!inRound.length) continue;
      choices.push(new p.Separator(`── Round ${r.round}`));
      for (const x of inRound) {
        choices.push({
          name: `${x.ref.padEnd(26)} ${x.issue.severity.padEnd(7)} [${x.outcome}] ${clip(x.issue.finding, 70)}`,
          value: x.ref,
          description: `${x.issue.finding}\n→ ${x.issue.recommendation}${x.disposition ? `\nAuthor (${x.disposition.action}): ${x.disposition.rationale}` : ""}`,
        });
      }
    }
    plan.reopen = await ask((ctx) => p.checkbox<string>({
      message: "Reopen any past issues? (Space to tick, Enter when done)",
      pageSize: 15,
      choices,
    }, ctx));
  }

  // 5. Note and rounds
  const note = await ask((ctx) => p.input({ message: "Note for Claude's next revision (optional, Enter to skip):" }, ctx));
  if (note.trim()) plan.note = note.trim();
  plan.more = (await ask((ctx) => p.number({ message: "How many more rounds?", default: 2, min: 1, max: 20, required: true }, ctx))) ?? 2;

  // 6. Confirm
  console.error(`\n${summarizePlan(plan, state)}\n`);
  const go = await ask((ctx) => p.confirm({ message: "Start?", default: true }, ctx));
  if (!go) {
    console.error("Not started. Nothing was changed.");
    return undefined;
  }
  return plan;
}

async function editScenarios(p: Prompts, plan: ContinuePlan, base: { id: string; text: string }[]): Promise<void> {
  // Working view: existing scenarios with pending edits/removals, plus pending additions.
  const edits = new Map<string, string>();
  const removed = new Set<string>();
  const added: string[] = [];

  while (true) {
    const current = base.filter((s) => !removed.has(s.id));
    if (current.length || added.length) {
      console.error("\nScenarios:");
      for (const s of current) console.error(`  ${s.id}: ${clip(edits.get(s.id) ?? s.text, 100)}${edits.has(s.id) ? "  (edited)" : ""}`);
      added.forEach((t, i) => console.error(`  new ${i + 1}: ${clip(t, 100)}`));
    }
    const action = await ask((ctx) => p.select<string>({
      message: current.length || added.length ? "Scenarios: anything to change?" : "Add scenarios for this idea?",
      choices: [
        { name: "Done with scenarios", value: "done" },
        { name: "Add a scenario (one line)", value: "add" },
        { name: "Add a longer scenario (opens your editor)", value: "add-editor" },
        ...current.map((s) => ({ name: `Edit ${s.id}`, value: `edit:${s.id}` })),
        ...current.map((s) => ({ name: `Remove ${s.id}`, value: `remove:${s.id}` })),
        ...added.map((_, i) => ({ name: `Drop new ${i + 1}`, value: `drop:${i}` })),
      ],
    }, ctx));

    if (action === "done") break;
    if (action === "add") {
      const t = await ask((ctx) => p.input({ message: "Scenario:", required: true }, ctx));
      if (t.trim()) added.push(t.trim());
    } else if (action === "add-editor") {
      const t = await ask((ctx) => p.editor({ message: "Describe the scenario (save and close the editor when done)" }, ctx));
      if (t.trim()) added.push(t.trim());
    } else if (action.startsWith("edit:")) {
      const id = action.slice(5);
      const old = edits.get(id) ?? base.find((s) => s.id === id)!.text;
      const t = await ask((ctx) => p.editor({ message: `Edit ${id} (save and close the editor when done)`, default: old }, ctx));
      if (t.trim() && t.trim() !== old) edits.set(id, t.trim());
    } else if (action.startsWith("remove:")) {
      const id = action.slice(7);
      removed.add(id);
      edits.delete(id);
    } else if (action.startsWith("drop:")) {
      added.splice(Number(action.slice(5)), 1);
    }
  }

  plan.addScenarios = added;
  plan.editScenarios = [...edits].map(([id, text]) => ({ id, text }));
  plan.removeScenarios = [...removed];
}

export function summarizePlan(plan: ContinuePlan, state: RunState): string {
  const lines = [`Idea: ${ideaTitle(state)} (${state.id})`];
  lines.push(plan.fromRound ? `Branch from round ${plan.fromRound} into a new run` : `Continue from round ${state.rounds.length}`);
  for (const t of plan.addScenarios) lines.push(`+ scenario: ${clip(t, 90)}`);
  for (const e of plan.editScenarios) lines.push(`~ ${e.id}: ${clip(e.text, 90)}`);
  for (const id of plan.removeScenarios) lines.push(`- ${id}`);
  for (const r of plan.reopen) lines.push(`↺ reopen ${r}`);
  if (plan.note) lines.push(`Note: ${clip(plan.note, 90)}`);
  lines.push(`Up to ${plan.more} more round(s)`);
  return lines.join("\n");
}

const clip = (t: string, n: number) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadConfig, MAX_REVIEWERS, type Config } from "./config.js";
import { emptyPlan, initialMaxRounds, prepareContinue, resumeMaxRounds, type ContinuePlan } from "./continue.js";
import { formatRow, runWizard } from "./continueWizard.js";
import { listRuns, pastIssues, resolveRunRef } from "./ideas.js";
import { IdeationLoop, type LoopOptions } from "./loop.js";
import { buildProviders, killChildren, waitForChildren } from "./providers.js";
import { renderReport } from "./report.js";
import { RunStore, type RoundRecord, type RunState } from "./store.js";
import { startServer } from "./ui/server.js";
import { liveness, startHeartbeat } from "./worker.js";

const USAGE = `ideate — primary AI ideates, secondary AIs critique, primary revises, in a bounded loop

Usage:
  ideate run      --brief <text|@file> [--context <text|@file>] [--title <text>] [options]
  ideate run      --proposal <text|@file> --rounds 1 [--brief ...]   Review your own plan as written
  ideate list                       Your ideas, newest first (branches under their parent)
  ideate continue                   Pick an idea with arrow keys and continue it (interactive)
  ideate continue <run> [continue options]
  ideate issues   <run>             Past issues with refs, for --reopen
  ideate resume   <run> [options]   Retry after a failure or quota pause
  ideate report   <run>
  ideate ui       [--port <n>] [--no-open]   Chat app in the browser (127.0.0.1, default port 4317)

<run> is a run ID or a row number from \`ideate list\`.

Options:
  --config <path>     Config file (default: config.json)
  --primary <name>    Override primary provider (run only)
  --reviewers <a,b>   Override secondary providers (run only)
  --rounds <n>        Override max rounds (run, resume)
  --id <id>           Use this run ID instead of a generated one (run only)
  --proposal <text|@file>  Start from this text as round 1's proposal; the primary doesn't write one
                      (run only). With --rounds 1 the run ends after the reviews. --brief is optional
  -i, --interactive   Pause after each review round for your feedback
  --worker            Started by the app: never prompts (can't be combined with -i)

Continue options:
  --scenario <text|@file>           Add a scenario the design must handle (repeatable)
  --edit-scenario <S2=text|@file>   Replace a scenario's text (repeatable)
  --remove-scenario <S2>            Remove a scenario (repeatable)
  --reopen <r2:agy:CORR-1>          Bring back a past issue (repeatable; see \`ideate issues\`)
  --from-round <n>                  Branch into a new run from round n; the original is kept
  --branch-id <id>                  Run ID for the new branch (with --from-round)
  --note <text|@file>               One-time feedback for Claude's next revision
  --more <n>                        Extra rounds to run (default 2)

Exit codes: 0 converged · 2 needs human decision · 75 paused on quota (resume later) · 1 error`;

const EXIT = { converged: 0, max_rounds: 2, stagnated: 2, stopped: 2, paused_quota: 75, failed: 1, running: 1 } as const;

/** The brief for `run --proposal` when none is given: reviewers judge the text as the owner wrote it. */
const OWN_PROPOSAL_BRIEF =
  "Review this plan as written. Is it correct, complete and safe to build as described? What is wrong, missing or risky?";

function validateRoster(cfg: Config, primary: string, secondaries: string[]): void {
  for (const n of [primary, ...secondaries]) {
    if (!cfg.providers[n]) throw new Error(`Provider "${n}" is not defined in the config's providers`);
  }
  if (secondaries.includes(primary)) throw new Error("Primary must not also be a reviewer");
  if (new Set(secondaries).size !== secondaries.length) throw new Error("Each reviewer may be listed only once");
  if (secondaries.length > MAX_REVIEWERS) throw new Error(`At most ${MAX_REVIEWERS} reviewers are supported`);
}

function readArg(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", default: "config.json" },
      brief: { type: "string" },
      context: { type: "string" },
      proposal: { type: "string" },
      primary: { type: "string" },
      reviewers: { type: "string" },
      rounds: { type: "string" },
      title: { type: "string" },
      scenario: { type: "string", multiple: true },
      "edit-scenario": { type: "string", multiple: true },
      "remove-scenario": { type: "string", multiple: true },
      reopen: { type: "string", multiple: true },
      "from-round": { type: "string" },
      note: { type: "string" },
      more: { type: "string" },
      id: { type: "string" },
      "branch-id": { type: "string" },
      worker: { type: "boolean", default: false },
      port: { type: "string" },
      "no-open": { type: "boolean", default: false },
      interactive: { type: "boolean", short: "i", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, runRef] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return 0;
  }

  if (values.worker && values.interactive) throw new Error("--worker can't be combined with -i/--interactive: workers never prompt");
  if (values.id !== undefined && cmd !== "run") throw new Error("--id is only for run");
  if (values.proposal !== undefined && cmd !== "run") throw new Error("--proposal is only for run");
  if (values["branch-id"] !== undefined && values["from-round"] === undefined) throw new Error("--branch-id needs --from-round");

  if (!existsSync(values.config!)) throw new Error(`Config not found: ${values.config}. Copy config.example.json to config.json.`);
  const cfg = loadConfig(values.config!);

  const runs = () => listRuns(cfg.runsDir);
  const runIdOf = (what: string) => {
    if (!runRef) throw new Error(`${what} requires <run>: a run ID or a row number from \`ideate list\``);
    return resolveRunRef(runs(), runRef).id;
  };

  if (cmd === "ui") return ui(values.config!, values.port as string | undefined, !values["no-open"]);
  if (cmd === "list") {
    printList();
    return 0;
  }
  if (cmd === "issues") {
    printIssues(RunStore.load(cfg.runsDir, runIdOf("issues")).state);
    return 0;
  }
  if (cmd === "report") {
    const { state } = RunStore.load(cfg.runsDir, runIdOf("report"));
    console.log(renderReport(state));
    return 0;
  }

  let store: RunStore;
  let state: RunState;
  const loopOpts: LoopOptions = {};

  if (cmd === "run") {
    const proposal = values.proposal === undefined ? undefined : readArg(values.proposal) ?? "";
    if (proposal !== undefined && !proposal.trim()) throw new Error("--proposal is empty");
    const brief = readArg(values.brief) ?? (proposal === undefined ? undefined : OWN_PROPOSAL_BRIEF);
    if (!brief) throw new Error("--brief is required");
    const primary = values.primary ?? cfg.primary;
    const secondaries = values.reviewers?.split(",").map((s) => s.trim()) ?? cfg.secondaries;
    validateRoster(cfg, primary, secondaries);

    if (values.id !== undefined) RunStore.assertNewId(cfg.runsDir, values.id);
    const id = values.id ?? RunStore.newId();
    store = new RunStore(cfg.runsDir, id);
    const now = new Date().toISOString();
    state = {
      id, createdAt: now, updatedAt: now, status: "running",
      brief, context: readArg(values.context), primary, secondaries,
      // A given proposal is round 1 as written: the loop only asks the primary for one when there is no round.
      rounds: proposal === undefined ? [] : [{ round: 1, proposal, reviews: {} }],
      title: values.title?.trim() || undefined,
      maxRounds: initialMaxRounds(cfg, values.rounds as string | undefined),
    };
    store.save(state);
    if (proposal !== undefined) store.writeArtifact("round-1/proposal.md", proposal);
    console.error(`Run ${id} → ${store.dir}`);
  } else if (cmd === "resume") {
    rejectRosterChange(values, "resume");
    ({ store, state } = RunStore.load(cfg.runsDir, runIdOf("resume")));
    refuseIfActive(store.dir, state.id);
    validateRoster(cfg, state.primary, state.secondaries);
    resumeMaxRounds(state, cfg, values.rounds as string | undefined);
    console.error(`Resuming ${state.id} from round ${state.rounds.length || 1} (was ${state.status})`);
  } else if (cmd === "continue") {
    rejectRosterChange(values, "continue");
    let plan: ContinuePlan | undefined;
    if (runRef) {
      plan = planFromFlags(resolveRunRef(runs(), runRef).id, values);
    } else {
      if (values.worker || !process.stdin.isTTY || !process.stderr.isTTY) {
        throw new Error("continue needs <run> when not in an interactive terminal (see `ideate list`)");
      }
      plan = await runWizard(runs(), cfg.runsDir);
      if (!plan) return 0;
    }
    const { store: originalStore, state: original } = RunStore.load(cfg.runsDir, plan.runId);
    validateRoster(cfg, original.primary, original.secondaries);
    // A branch only reads the original and writes a new run, so it's allowed while the original is busy.
    if (plan.fromRound === undefined) {
      refuseIfActive(originalStore.dir, original.id);
      if (original.status === "running") {
        console.error(`Warning: run ${original.id} is marked "running". If another ideate process is still working on it, stop that first.`);
      }
    }
    const prepared = prepareContinue(cfg.runsDir, plan);
    ({ store, state } = prepared);
    for (const line of prepared.changes) console.error(line);
    loopOpts.continueRun = true;
  } else {
    throw new Error(`Unknown command "${cmd}"\n\n${USAGE}`);
  }

  const providers = buildProviders(cfg.providers, [state.primary, ...state.secondaries], cfg.loop.timeoutSec);
  const loop = new IdeationLoop(cfg, providers, store, state, {
    log: (m) => console.error(m),
    humanGate: values.interactive ? humanGate : undefined,
  }, loopOpts);

  const stopHeartbeat = startHeartbeat(store.dir, process.argv.slice(2));
  let stopping = false;
  const onSignal = (detail: string) => () => {
    if (stopping) {
      killChildren(); // second signal: give up on a clean stop, but leave no agent CLI behind
      process.exit(130);
    }
    stopping = true;
    console.error(`\n${detail}; finishing up…`);
    loop.requestStop(detail);
  };
  const onTerm = onSignal("Stopped from the app");
  const onInt = onSignal("Stopped");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    const final = await loop.run();
    // A stop aborts in-flight agent CLIs; one that ignores SIGTERM is killed after the grace
    // period. Wait for that: once this process exits, nothing would kill it.
    await waitForChildren();
    rl?.close();
    const report = renderReport(final);
    writeFileSync(join(store.dir, "report.md"), report);
    console.error(`\nReport: ${join(store.dir, "report.md")}`);
    return EXIT[final.status];
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    stopHeartbeat();
  }

  function printList(): void {
    const all = runs();
    if (!all.length) {
      console.log("No ideas yet. Start one with: ideate run --brief \"...\" --title \"...\"");
      return;
    }
    console.log(` #  ${"Idea".padEnd(48)}  ${"Status".padEnd(12)} Rds  ${"Last score".padEnd(11)}  Scen.`);
    all.forEach((r) => console.log(`${formatRow(r)}\n    ${r.id} · updated ${r.updatedAt.slice(0, 16).replace("T", " ")}`));
  }
}

/** Serves the chat app until Ctrl-C. Runs started from it are separate processes and keep going. */
async function ui(cfgPath: string, portFlag: string | undefined, open: boolean): Promise<number> {
  const port = portFlag === undefined ? 4317 : Number(portFlag);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0-65535, got "${portFlag}"`);
  const server = await startServer({ cfgPath, port, host: "127.0.0.1" });
  console.error(`ideate ui → ${server.url}  (Ctrl-C to stop; running ideas keep going)`);
  if (open) {
    const opener = spawn(process.platform === "darwin" ? "open" : "xdg-open", [server.url], { stdio: "ignore", detached: true });
    opener.on("error", () => { /* no browser opener: the URL is printed above */ });
    opener.unref();
  }
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await server.close();
  return 0;
}

type Values = Record<string, string | string[] | boolean | undefined>;

function rejectRosterChange(values: Values, cmd: string): void {
  if (values.primary || values.reviewers) {
    throw new Error(`--primary and --reviewers can't change on ${cmd}: the run's reviews are tied to its original providers. Start a new run instead.`);
  }
}

/** One process per idea. */
function refuseIfActive(runDir: string, id: string): void {
  const live = liveness(runDir);
  if (live.active) throw new Error(`Run ${id} is already running (pid ${live.pid})`);
}

function planFromFlags(runId: string, values: Values): ContinuePlan {
  const list = (k: string) => (values[k] as string[] | undefined) ?? [];
  const plan = emptyPlan(runId);
  plan.addScenarios = list("scenario").map((v) => readArg(v)!);
  plan.editScenarios = list("edit-scenario").map((v) => {
    const eq = v.indexOf("=");
    if (eq < 1) throw new Error(`--edit-scenario expects S<n>=<text|@file>, got "${v}"`);
    return { id: v.slice(0, eq).trim(), text: readArg(v.slice(eq + 1))! };
  });
  plan.removeScenarios = list("remove-scenario");
  plan.reopen = list("reopen");
  plan.note = readArg(values.note as string | undefined);
  if (values["from-round"] !== undefined) plan.fromRound = intFlag("--from-round", values["from-round"] as string);
  plan.branchId = values["branch-id"] as string | undefined;
  if (values.more !== undefined) plan.more = intFlag("--more", values.more as string);
  return plan;
}

function intFlag(name: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${v}"`);
  return n;
}

function printIssues(state: RunState): void {
  const issues = pastIssues(state);
  if (!issues.length) {
    console.log("No review issues in this run yet.");
    return;
  }
  for (const r of state.rounds) {
    const inRound = issues.filter((x) => x.round === r.round);
    if (!inRound.length) continue;
    console.log(`\nRound ${r.round}`);
    for (const x of inRound) {
      const f = x.issue.finding.replace(/\s+/g, " ");
      console.log(`  ${x.ref.padEnd(28)} ${x.issue.severity.padEnd(7)} ${`[${x.outcome}]`.padEnd(26)} ${f.length > 90 ? `${f.slice(0, 89)}…` : f}`);
    }
  }
  console.log(`\nReopen with: ideate continue ${state.id} --reopen <ref>`);
}

// One readline for the whole run: re-creating it per prompt drops buffered piped input.
// stdin EOF (Ctrl-D, or end of piped input) is treated as "stop", otherwise a pending
// question would leave the event loop empty and the process would exit without a report.
let rl: ReturnType<typeof createInterface> | undefined;
let closed: Promise<null> | undefined;

async function humanGate(r: RoundRecord): Promise<string | null | undefined> {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stderr });
    const cur = rl;
    closed = new Promise<null>((res) => cur.once("close", () => res(null)));
  }
  console.error(`\n── Round ${r.round}: mean ${r.meanScore?.toFixed(1)}, blockers ${r.blockers}`);
  for (const [name, rv] of Object.entries(r.reviews)) {
    console.error(`  ${name} ${rv.score}/10: ${rv.summary}`);
    for (const i of rv.issues.filter((x) => x.severity !== "minor")) console.error(`    - ${i.severity} ${i.id}: ${i.finding}`);
  }
  const raw = await Promise.race([rl.question("\n[Enter] continue · type feedback for the primary · 'q' stop\n> "), closed!]);
  if (raw === null) return null;
  const ans = raw.trim();
  if (ans.toLowerCase() === "q") return null;
  return ans || undefined;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  },
);

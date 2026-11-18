import type { z } from "zod";
import type { Config } from "./config.js";
import { extractJson, extractText } from "./json.js";
import { applyInbox, readInbox } from "./inbox.js";
import { LiveLog } from "./live.js";
import {
  DEFAULT_RUBRIC, generatePrompt, missingDispositionsPrompt, repairPrompt, reviewPrompt, revisePrompt,
  type OwnerIssue, type PriorIssue, type PromptContext,
} from "./prompts.js";
import { activeScenarios, LABELS, OWNER_LABEL } from "./ideas.js";
import { QuotaError, StopError, type Provider, type Role } from "./providers.js";
import { Dispositions, JSON_SHAPES, Review, Revision, type Disposition, type Issue } from "./schema.js";
import type { RoundRecord, RunState, RunStore } from "./store.js";

export interface LoopHooks {
  log: (msg: string) => void;
  /** Called between rounds. Return undefined to continue, a string to inject feedback, or null to stop. */
  humanGate?: (round: RoundRecord) => Promise<string | null | undefined>;
}

export interface LoopOptions {
  /**
   * Set by `ideate continue`: run past the stop rules once for the already-scored last round
   * (otherwise a converged, stagnated or max-rounds run would stop again immediately).
   */
  continueRun?: boolean;
}

export class IdeationLoop {
  constructor(
    private cfg: Config,
    private providers: Map<string, Provider>,
    private store: RunStore,
    private state: RunState,
    private hooks: LoopHooks,
    private opts: LoopOptions = {},
  ) {
    this.live = new LiveLog(store.dir);
  }

  private live: LiveLog;
  private abort = new AbortController();
  private stopDetail?: string;

  /** Aborts in-flight calls and ends the run as `stopped`. */
  requestStop(detail: string): void {
    this.stopDetail = detail;
    this.abort.abort();
  }

  /** Built per call: scenarios can be added to a run between continues. */
  private get ctx(): PromptContext {
    const scenarios = activeScenarios(this.state);
    return {
      brief: this.state.brief, context: this.state.context, rubric: this.cfg.rubric ?? DEFAULT_RUBRIC,
      scenarios: scenarios.length ? scenarios : undefined,
    };
  }

  async run(): Promise<RunState> {
    const { log } = this.hooks;
    this.state.status = "running";
    this.state.statusDetail = undefined;

    try {
      // Round 1 proposal
      if (this.state.rounds.length === 0) {
        log(`[r1] ${this.state.primary} generating initial proposal`);
        const proposal = await this.callText(this.state.primary, "generate", 1, generatePrompt(this.ctx));
        this.state.rounds.push({ round: 1, proposal, reviews: {} });
        this.store.writeArtifact("round-1/proposal.md", proposal);
        this.checkpoint();
      }

      let skipStopCheck = !!this.opts.continueRun;
      while (true) {
        const cur = this.current();
        const r = cur.round;

        await this.collectReviews(cur);
        this.score(cur);
        log(`[r${r}] mean ${cur.meanScore!.toFixed(1)}, min ${cur.minScore!.toFixed(1)}, blockers ${cur.blockers}`);
        this.checkpoint();

        this.drainInbox(cur, "more");
        const stop = skipStopCheck ? undefined : this.stopReason(cur);
        if (skipStopCheck) log(`[r${r}] continuing past the previous stop (${this.state.rounds.length} round(s) so far)`);
        skipStopCheck = false;
        if (stop) {
          this.state.status = stop.status;
          this.state.statusDetail = stop.detail;
          log(`[r${r}] stopping: ${stop.detail}`);
          break;
        }

        if (cur.revision) {
          // Revision already done before an interruption; advance.
        } else {
          let answer: string | undefined;
          if (this.hooks.humanGate && !cur.gateDone) {
            const fb = await this.hooks.humanGate(cur);
            if (fb === null) {
              this.state.status = "stopped";
              this.state.statusDetail = "Stopped by human";
              break;
            }
            answer = fb?.trim();
            cur.gateDone = true;
          }
          // Everything the owner queued so far goes into this revision; the gate answer comes last.
          this.drainInbox(cur, "all");
          if (answer) cur.humanFeedback = cur.humanFeedback ? `${cur.humanFeedback}\n\n${answer}` : answer;
          this.checkpoint();

          log(`[r${r}] ${this.state.primary} revising against ${Object.keys(cur.reviews).length} reviews`);
          const reviews = this.labelled(cur);
          const owner = ownerIssues(cur);
          const revision = await this.callJson(
            this.state.primary, "revise", r,
            revisePrompt(this.ctx, cur.proposal, r, reviews, cur.humanFeedback || undefined, owner),
            Revision, JSON_SHAPES.revision,
          );
          const items = [
            ...reviews.flatMap(({ label, review }) => review.issues.map((issue) => ({ ref: `${label}:${issue.id}`, issue }))),
            ...owner,
          ];
          cur.undisposed = await this.completeDispositions(r, items, revision);
          cur.revision = revision;
          this.store.writeArtifact(`round-${r}/revision.json`, JSON.stringify(cur.revision, null, 2));
          this.checkpoint();
        }

        const next: RoundRecord = { round: r + 1, proposal: cur.revision!.proposal, reviews: {} };
        this.state.rounds.push(next);
        this.store.writeArtifact(`round-${next.round}/proposal.md`, next.proposal);
        this.checkpoint();
      }
    } catch (e) {
      if (e instanceof StopError || this.abort.signal.aborted) {
        this.state.status = "stopped";
        this.state.statusDetail = this.stopDetail ?? "Stopped";
        log(`Stopped: ${this.state.statusDetail}`);
      } else if (e instanceof QuotaError) {
        this.state.status = "paused_quota";
        this.state.statusDetail = e.message;
        log(`Paused: ${e.message}\nResume later with: ideate resume ${this.state.id}`);
      } else {
        this.state.status = "failed";
        this.state.statusDetail = (e as Error).message;
        log(`Failed: ${(e as Error).message}\nFix the cause, then: ideate resume ${this.state.id}`);
      }
    }
    this.checkpoint();
    return this.state;
  }

  /**
   * Applies queued inbox items to `cur`. "more" applies only `more` items (before a stop check, so
   * extra rounds count right away), remembering their ts so they aren't applied twice; "all"
   * applies everything left and advances `inboxConsumed`. Items still queued when a run ends stay
   * queued for the next continue/resume.
   */
  private drainInbox(cur: RoundRecord, which: "more" | "all"): void {
    const from = this.state.inboxConsumed ?? 0;
    const { items, offset } = readInbox(this.store.dir, from);
    const early = new Set(this.state.inboxMoreApplied ?? []);
    const todo = items.filter((i) => !(i.type === "more" && early.has(i.ts)) && (which === "all" || i.type === "more"));
    if (todo.some((i) => i.type === "more")) this.state.maxRounds ??= this.cfg.loop.maxRounds;
    for (const line of applyInbox(this.state, cur, todo)) this.hooks.log(`[r${cur.round}] inbox: ${line}`);
    if (which === "more") {
      if (todo.length) this.state.inboxMoreApplied = [...early, ...todo.map((i) => i.ts)];
    } else if (offset !== from) {
      this.state.inboxConsumed = offset;
      delete this.state.inboxMoreApplied;
    }
    if (todo.length) this.checkpoint();
  }

  private current(): RoundRecord {
    return this.state.rounds[this.state.rounds.length - 1]!;
  }

  /** Reviews run in parallel. Completed reviews are kept even if a sibling fails, so resume only redoes what's missing. */
  private async collectReviews(cur: RoundRecord): Promise<void> {
    const prev = this.state.rounds[cur.round - 2];
    const todo = this.state.secondaries.filter((s) => !cur.reviews[s]);
    if (!todo.length) return;

    this.hooks.log(`[r${cur.round}] reviewing with ${todo.join(", ")}`);
    const results = await Promise.allSettled(
      todo.map(async (name) => {
        // Each reviewer sees only its own previous issues, each paired with the author's response.
        const label = this.labelOf(name);
        const mine: PriorIssue[] | undefined = prev?.reviews[name]?.issues.map((issue) => ({
          issue,
          disposition: prev.revision?.dispositions.find((d) => d.issue_ref === `${label}:${issue.id}`),
        }));
        // Every reviewer sees the issues the owner reopened last round, with the author's response.
        const owner = prev ? ownerIssues(prev).map((o) => ({
          ...o, disposition: prev.revision?.dispositions.find((d) => d.issue_ref === o.ref),
        })) : [];
        const review = await this.callJson(name, "review", cur.round,
          reviewPrompt(this.ctx, cur.proposal, cur.round, mine, owner), Review, JSON_SHAPES.review);
        cur.reviews[name] = review;
        this.store.writeArtifact(`round-${cur.round}/review-${name}.json`, JSON.stringify(review, null, 2));
        this.checkpoint();
      }),
    );
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
    if (failures.length) throw failures.find((f) => f instanceof QuotaError) ?? failures[0];
  }

  private score(cur: RoundRecord): void {
    const reviews = Object.values(cur.reviews);
    const scores = reviews.map((r) => r.score);
    cur.meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    cur.minScore = Math.min(...scores);
    cur.blockers = reviews.flatMap((r) => r.issues).filter((i) => i.severity === "blocker").length;
  }

  private stopReason(cur: RoundRecord): { status: RunState["status"]; detail: string } | undefined {
    const L = this.cfg.loop;
    if (cur.minScore! >= L.passScore && cur.blockers! <= L.maxBlockers) {
      return { status: "converged", detail: `All reviewers >= ${L.passScore}, blockers ${cur.blockers}` };
    }
    const maxRounds = this.state.maxRounds ?? L.maxRounds;
    if (cur.round >= maxRounds) {
      return { status: "max_rounds", detail: `Reached max rounds (${maxRounds}) without convergence — human decision needed` };
    }
    // After `ideate continue`, only rounds after the continue point count: earlier flat scores
    // shouldn't stop a run the owner just pushed in a new direction.
    const floor = Math.max(0, ...this.state.rounds.filter((x) => x.continuedAt).map((x) => x.round));
    const window = this.state.rounds.filter((x) => x.round > floor).slice(-(L.stagnationRounds + 1));
    if (window.length === L.stagnationRounds + 1) {
      const gain = window[window.length - 1]!.meanScore! - window[0]!.meanScore!;
      if (gain < L.minDelta * L.stagnationRounds) {
        return { status: "stagnated", detail: `Mean score gained ${gain.toFixed(2)} over ${L.stagnationRounds} rounds — reviewers and author are not converging` };
      }
    }
    return undefined;
  }

  private labelOf(name: string): string {
    // Never fall back to the provider name: that would reveal the vendor to the primary.
    const label = LABELS[this.state.secondaries.indexOf(name)];
    if (!label) throw new Error(`No anonymous label for reviewer "${name}" (max ${LABELS.length} reviewers)`);
    return label;
  }

  /** Primary sees "Reviewer A/B", not vendor names — avoids brand deference. */
  private labelled(cur: RoundRecord) {
    return this.state.secondaries
      .filter((s) => cur.reviews[s])
      .map((s) => ({ label: this.labelOf(s), review: cur.reviews[s]! }));
  }

  /**
   * Every review issue and owner-reopened issue must get a disposition. Refs are normalised
   * ("<label>:<id>", "OWNER:<n>") so they can be matched later; skipped issues get one follow-up
   * request. Returns refs still unanswered after that.
   */
  private async completeDispositions(
    round: number,
    items: { ref: string; issue: Issue }[],
    revision: Revision,
  ): Promise<string[]> {
    const expected = new Map<string, { ref: string; issue: Issue }>();
    for (const item of items) expected.set(normRef(item.ref), item);
    const canonicalise = (ds: Disposition[]) => {
      for (const d of ds) d.issue_ref = expected.get(normRef(d.issue_ref))?.ref ?? d.issue_ref;
    };
    const missing = () => [...expected.values()].filter((e) => !revision.dispositions.some((d) => d.issue_ref === e.ref));

    canonicalise(revision.dispositions);
    let gaps = missing();
    if (gaps.length) {
      const { primary } = this.state;
      this.hooks.log(`[r${round}] ${primary} skipped ${gaps.length} issue(s); asking for dispositions`);
      try {
        const extra = await this.callJson(primary, "revise", round,
          missingDispositionsPrompt(round, gaps), Dispositions, JSON_SHAPES.dispositions);
        canonicalise(extra.dispositions);
        const wanted = new Set(gaps.map((g) => g.ref));
        revision.dispositions.push(...extra.dispositions.filter((d) => wanted.has(d.issue_ref)));
        gaps = missing();
      } catch (e) {
        if (e instanceof QuotaError) throw e;
        this.hooks.log(`[r${round}] follow-up for dispositions failed: ${(e as Error).message.slice(0, 200)}`);
      }
      if (gaps.length) this.hooks.log(`[r${round}] still unanswered: ${gaps.map((g) => g.ref).join(", ")}`);
    }
    return gaps.map((g) => g.ref);
  }

  private async callText(name: string, role: Role, round: number, prompt: string): Promise<string> {
    const id = this.live.start({ provider: name, role, round });
    const t0 = Date.now();
    try {
      const out = await this.providers.get(name)!.complete(prompt, role, {
        onDelta: (text) => this.live.delta(id, text),
        signal: this.abort.signal,
      });
      this.store.logCall(name, role, round, prompt, out);
      this.live.end(id, true, Date.now() - t0);
      return extractText(out);
    } catch (e) {
      this.live.end(id, false, Date.now() - t0, (e as Error).message.slice(0, 300));
      throw e;
    }
  }

  private async callJson<T extends z.ZodTypeAny>(
    name: string, role: Role, round: number, prompt: string, schema: T, shape: string,
  ): Promise<z.infer<T>> {
    let out = await this.callText(name, role, round, prompt);
    for (let attempt = 0; ; attempt++) {
      try {
        return schema.parse(extractJson(out));
      } catch (e) {
        if (attempt >= this.cfg.loop.repairAttempts) {
          throw new Error(`${name} (${role}, round ${round}) returned invalid JSON: ${(e as Error).message.slice(0, 300)}`);
        }
        this.hooks.log(`[r${round}] ${name} returned malformed JSON, asking for repair`);
        out = await this.callText(name, role, round, repairPrompt(shape, out, (e as Error).message.slice(0, 200)));
      }
    }
  }

  private checkpoint(): void {
    this.store.save(this.state);
  }
}

/** "[a : sec-1]" -> "A:SEC-1", so minor formatting differences from the model still match. */
function normRef(ref: string): string {
  return ref.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/\s+/g, "").toUpperCase();
}

/** Owner-reopened issues on a round, with the refs the primary answers them under. */
function ownerIssues(r: RoundRecord): OwnerIssue[] {
  return (r.reopened ?? []).map((o, i) => ({ ref: `${OWNER_LABEL}:${i + 1}`, issue: o.issue }));
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyPlan, prepareContinue } from "../src/continue.js";
import { appendInbox, applyInbox, readInbox, type InboxItem } from "../src/inbox.js";
import { readLive, type LiveEvent } from "../src/live.js";
import { IdeationLoop, type LoopHooks } from "../src/loop.js";
import type { Provider } from "../src/providers.js";
import { RunStore } from "../src/store.js";
import { config, newRun, review, scripted, transcript } from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "inbox-test-"));
const ts = () => new Date().toISOString();
let seq = 0;
/** Unique ts per item: the loop tells applied `more` items apart by ts. */
const item = <T extends Omit<InboxItem, "ts">>(i: T): InboxItem => ({ ...i, ts: `${ts()}#${++seq}` }) as InboxItem;

/** Waits until live.jsonl has an event matching `pred` (the run is observably at that point). */
async function untilLive(dir: string, pred: (e: LiveEvent) => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!readLive(dir, 0).events.some(pred)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for live event");
    await new Promise((r) => setTimeout(r, 2));
  }
}

const primary = () => scripted("p", (prompt, role) => {
  if (role === "generate") return "## Proposal";
  const refs = [...new Set([...prompt.matchAll(/\[([A-Z]+:[A-Za-z0-9-]+)\]/g)].map((m) => m[1]!))];
  return JSON.stringify({ proposal: "## Revised", dispositions: refs.map((issue_ref) => ({ issue_ref, action: "accepted", rationale: "ok" })) });
});

/**
 * Reviewers that hold their round-1 review until the test releases them, so the test can queue
 * inbox items while the review is observably in flight.
 */
function heldRun(loop: Record<string, unknown>, hooks: Partial<LoopHooks> = {}) {
  const cfg = config(loop);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const reviewer = (name: string) => scripted(name, async (_prompt, _role, call) => {
    if (call === 1) await held; // round-1 review
    return review(5, [{ id: "X-1" }]);
  });
  const providers = new Map<string, Provider>([["p", primary()], ["a", reviewer("a")], ["b", reviewer("b")]]);
  const run = newRun(cfg);
  const logs: string[] = [];
  const done = new IdeationLoop(cfg, providers, run.store, run.state, { log: (m) => logs.push(m), ...hooks }).run();
  const duringReview = async (items: InboxItem[]) => {
    await untilLive(run.store.dir, (e) => e.t === "call_start" && e.role === "review");
    for (const i of items) appendInbox(run.store.dir, i);
    release();
  };
  return { cfg, providers, ...run, logs, done, duringReview };
}

const revisePrompt = (store: RunStore, round: number) =>
  transcript(store).filter((e) => e.role === "revise" && e.round === round).map((e) => e.prompt)[0]!;

test("note and scenario queued mid-review reach the next revision", async () => {
  const run = heldRun({ maxRounds: 2 });
  await run.duringReview([item({ type: "note", text: "Keep it boring" }), item({ type: "add_scenario", text: "Two CHWs share one phone" })]);
  const final = await run.done;
  assert.equal(final.rounds.length, 2);
  const p = revisePrompt(run.store, 1);
  assert.match(p, /Feedback from the human owner \(highest priority\)\nKeep it boring/);
  assert.match(p, /- S1 \(NEW this round\): Two CHWs share one phone/);
  assert.equal(final.inboxConsumed, readInbox(run.store.dir, 0).offset);
});

test("more raises the limit of a running run", async () => {
  const run = heldRun({ maxRounds: 1 });
  await run.duringReview([item({ type: "more", n: 1 })]);
  const final = await run.done;
  assert.equal(final.status, "max_rounds");
  assert.equal(final.rounds.length, 2);
  assert.equal(final.maxRounds, 2);
  assert.ok(final.rounds[0]!.revision);
});

test("items left at the end are used by the next continue", async () => {
  const run = heldRun({ maxRounds: 1 });
  await run.duringReview([item({ type: "note", text: "Queued too late" })]);
  const first = await run.done;
  assert.equal(first.status, "max_rounds");
  assert.equal(first.inboxConsumed, undefined, "nothing consumed: the run ended before a revision");

  const prepared = prepareContinue(run.cfg.runsDir, { ...emptyPlan(first.id), more: 1 });
  const final = await new IdeationLoop(run.cfg, run.providers, prepared.store, prepared.state, { log: () => {} }, { continueRun: true }).run();
  assert.equal(final.rounds.length, 2);
  assert.match(revisePrompt(run.store, 1), /Feedback from the human owner \(highest priority\)\nQueued too late/);
  assert.deepEqual(readInbox(run.store.dir, final.inboxConsumed!).items, []);
  assert.equal(RunStore.load(run.cfg.runsDir, first.id).state.inboxConsumed, final.inboxConsumed);
});

test("+N rounds applied early to a run that then stops is used by the next continue, once", async () => {
  const cfg = config({ maxRounds: 1 });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  // Reviewers pass on round 1 (the run converges); later rounds keep them below the bar.
  const reviewer = (name: string) => scripted(name, async (_prompt, _role, call) => {
    if (call === 1) { await held; return review(9); }
    return review(5, [{ id: "X-1" }]);
  });
  const providers = new Map<string, Provider>([["p", primary()], ["a", reviewer("a")], ["b", reviewer("b")]]);
  const run = newRun(cfg);
  const done = new IdeationLoop(cfg, providers, run.store, run.state, { log: () => {} }).run();
  await untilLive(run.store.dir, (e) => e.t === "call_start" && e.role === "review");
  appendInbox(run.store.dir, item({ type: "more", n: 2 }));
  release();
  const first = await done;
  assert.equal(first.status, "converged");
  assert.equal(first.maxRounds, 3, "applied early");

  const prepared = prepareContinue(cfg.runsDir, { ...emptyPlan(first.id), more: 1 });
  const logs: string[] = [];
  const final = await new IdeationLoop(cfg, providers, prepared.store, prepared.state, { log: (m) => logs.push(m) }, { continueRun: true }).run();
  assert.equal(final.maxRounds, 1 + 1 + 2, "continue's +1 and the queued +2 both count");
  assert.equal(final.status, "max_rounds");
  assert.equal(final.rounds.length, 4);
  // Applied once: by the continue (its queue goes first) or by the loop, never both.
  const applied = [...prepared.changes, ...logs].filter((l) => /Up to 2 more/.test(l));
  assert.equal(applied.length, 1, [...prepared.changes, ...logs].join("\n"));
  assert.deepEqual(readInbox(run.store.dir, final.inboxConsumed!).items, []);
  assert.equal(final.inboxMoreApplied, undefined);
});

test("continue --note: notes queued earlier come before the new note", async () => {
  const run = heldRun({ maxRounds: 1 });
  await run.duringReview([item({ type: "note", text: "older" })]);
  const first = await run.done;
  assert.equal(first.inboxConsumed, undefined);
  const prepared = prepareContinue(run.cfg.runsDir, { ...emptyPlan(first.id), note: "newer", more: 1 });
  const final = await new IdeationLoop(run.cfg, run.providers, prepared.store, prepared.state, { log: () => {} }, { continueRun: true }).run();
  assert.match(revisePrompt(run.store, 1), /Feedback from the human owner \(highest priority\)\nolder\n\nnewer\n/);
  assert.deepEqual(readInbox(run.store.dir, final.inboxConsumed!).items, []);
});

test("invalid items are skipped, not fatal", async () => {
  const run = heldRun({ maxRounds: 2 });
  await run.duringReview([item({ type: "remove_scenario", id: "S9" }), item({ type: "note", text: "still here" })]);
  const final = await run.done;
  assert.equal(final.status, "max_rounds");
  assert.equal(final.rounds.length, 2);
  assert.ok(run.logs.some((l) => /Skipped/.test(l) && /S9/.test(l)), run.logs.join("\n"));
  assert.match(revisePrompt(run.store, 1), /still here/);
});

test("inbox note and -i answer both reach Claude", async () => {
  const run = heldRun({ maxRounds: 2 }, { humanGate: async () => "typed" });
  await run.duringReview([item({ type: "note", text: "queued" })]);
  const final = await run.done;
  assert.ok(final.rounds[0]!.gateDone);
  assert.match(revisePrompt(run.store, 1), /Feedback from the human owner \(highest priority\)\nqueued\n\ntyped\n/);
});

test("a branch gets its own gate and inbox; the parent's queue stays on the parent", async () => {
  const run = heldRun({ maxRounds: 2 }, { humanGate: async () => undefined });
  await run.duringReview([item({ type: "note", text: "parent note" })]);
  const parent = await run.done;
  assert.ok(parent.inboxConsumed! > 0);
  appendInbox(run.store.dir, item({ type: "note", text: "left on parent" }));

  const prepared = prepareContinue(run.cfg.runsDir, { ...emptyPlan(parent.id), fromRound: 1, more: 1 });
  appendInbox(prepared.store.dir, item({ type: "note", text: "for the branch" }));
  let gates = 0;
  const final = await new IdeationLoop(run.cfg, run.providers, prepared.store, prepared.state,
    { log: () => {}, humanGate: async () => { gates++; return undefined; } }, { continueRun: true }).run();
  assert.notEqual(final.id, parent.id);
  assert.equal(gates, 1, "the gate runs for the branch's revision");
  const p = revisePrompt(prepared.store, 1);
  assert.match(p, /for the branch/);
  assert.doesNotMatch(p, /left on parent|parent note/);
  assert.equal(readInbox(run.store.dir, RunStore.load(run.cfg.runsDir, parent.id).state.inboxConsumed!).items.length, 1);
});

test("applyInbox: changes, duplicates and skips", () => {
  const { state } = newRun(config());
  state.rounds.push({
    round: 1, proposal: "p", reviews: { a: JSON.parse(review(5, [{ id: "X-1" }])) },
    meanScore: 5, humanFeedback: "first",
  });
  state.maxRounds = 3;
  const r = state.rounds[0]!;
  const lines = applyInbox(state, r, [
    item({ type: "add_scenario", text: "A" }),
    item({ type: "edit_scenario", id: "s1", text: "A2" }),
    item({ type: "note", text: "second" }),
    item({ type: "reopen", ref: "r1:a:X-1" }),
    item({ type: "reopen", ref: "R1:A:x-1" }),
    item({ type: "more", n: 2 }),
    item({ type: "remove_scenario", id: "S1" }),
    item({ type: "remove_scenario", id: "S1" }),
    item({ type: "more", n: 0 }),
    { type: "bogus", ts: ts() } as unknown as InboxItem,
  ]);
  assert.equal(r.humanFeedback, "first\n\nsecond");
  assert.deepEqual(r.reopened?.map((o) => o.ref), ["r1:a:X-1"]);
  assert.equal(state.maxRounds, 5);
  assert.deepEqual(state.scenarios, [{ id: "S1", text: "A2", addedRound: 1, editedRound: 1, removedRound: 1 }]);
  assert.equal(lines.filter((l) => l.startsWith("Skipped:")).length, 3, lines.join("\n"));
});

test("readInbox returns complete items only and skips torn lines", () => {
  const dir = tmp();
  const f = join(dir, "inbox.jsonl");
  appendInbox(dir, item({ type: "note", text: "one" }));
  appendFileSync(f, '{"type":"note","te'); // torn by a hard kill
  const torn = readInbox(dir, 0);
  assert.equal(torn.items.length, 1);
  assert.equal(torn.offset, readFileSync(f).indexOf("\n") + 1);
  appendInbox(dir, item({ type: "note", text: "two" }));
  const r = readInbox(dir, 0);
  assert.deepEqual(r.items.map((i) => (i as { text: string }).text), ["one", "two"]);
  assert.equal(r.offset, readFileSync(f).length);
  assert.deepEqual(readInbox(dir, r.offset).items, []);
  assert.deepEqual(readInbox(tmp(), 0), { items: [], offset: 0 });
});

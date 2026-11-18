import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveEvent } from "../../../src/live";
import type { ChatMessage } from "../../../src/ui/types";
import { EMPTY_LIVE, liveReducer, liveTurns, type LiveState } from "./liveStream";

type Ev = { offset: number; event: LiveEvent };
const TS = "2026-11-13T10:00:00.000Z";
const start = (call: number, provider: string, role: "generate" | "review" | "revise", round: number): LiveEvent =>
  ({ t: "call_start", call, provider, role, round, ts: TS });
const delta = (call: number, text: string): LiveEvent => ({ t: "delta", call, text });
const end = (call: number, ok = true): LiveEvent => ({ t: "call_end", call, ok, ms: 10, ts: TS });

/** Events with increasing byte offsets. */
const withOffsets = (events: LiveEvent[]): Ev[] => events.map((event, i) => ({ offset: (i + 1) * 100, event }));
const run = (evs: Ev[], from: LiveState = EMPTY_LIVE) => evs.reduce(liveReducer, from);

test("liveReducer accumulates deltas per call", () => {
  const s = run(withOffsets([
    start(1, "a", "review", 1), start(2, "b", "review", 1),
    delta(1, "he"), delta(2, "wo"), delta(1, "llo"), delta(2, "rld"),
  ]));
  assert.equal(s.offset, 600);
  assert.equal(s.calls[1]!.text, "hello");
  assert.equal(s.calls[2]!.text, "world");
  assert.deepEqual({ ...s.calls[1]!, text: "" }, { provider: "a", role: "review", round: 1, ts: TS, text: "", done: false });
});

test("liveReducer ignores replayed events, so a reconnect never duplicates text", () => {
  const evs = withOffsets([start(1, "p", "generate", 1), delta(1, "ab"), delta(1, "cd")]);
  const once = run(evs);
  assert.deepEqual(run(evs, once), once);
  // Resuming from an earlier offset (overlap) only adds what's new.
  const more = withOffsets([start(1, "p", "generate", 1), delta(1, "ab"), delta(1, "cd"), delta(1, "ef")]);
  assert.equal(run(more.slice(1), once).calls[1]!.text, "abcdef");
});

test("liveReducer marks call_end done with ok", () => {
  const s = run(withOffsets([start(1, "a", "review", 1), start(2, "b", "review", 1), end(1), end(2, false)]));
  assert.equal(s.calls[1]!.done, true);
  assert.equal(s.calls[1]!.ok, true);
  assert.equal(s.calls[2]!.done, true);
  assert.equal(s.calls[2]!.ok, false);
});

const msg = (key: string): ChatMessage => ({ key, speaker: "primary", name: "p", round: 1, status: "", kind: "proposal" });

test("liveTurns shows the call in progress, with parallel reviews both streaming", () => {
  const s = run(withOffsets([start(1, "p", "generate", 1), delta(1, "x"), end(1), start(2, "a", "review", 1), start(3, "b", "review", 1)]));
  const turns = liveTurns(s, [msg("brief"), msg("r1-proposal")], true);
  assert.deepEqual(turns.map((t) => [t.call, t.phase]), [[2, "streaming"], [3, "streaming"]]);
});

test("liveTurns keeps a finished call until its formatted message lands", () => {
  const s = run(withOffsets([start(1, "p", "generate", 1), delta(1, "x"), end(1)]));
  assert.deepEqual(liveTurns(s, [msg("brief")], true).map((t) => [t.call, t.phase]), [[1, "done"]]);
  assert.deepEqual(liveTurns(s, [msg("brief"), msg("r1-proposal")], true), []);
  // A failed call is dropped: a retry or the end card says what happened.
  const failed = run(withOffsets([start(1, "p", "generate", 1), delta(1, "x"), end(1, false)]));
  assert.deepEqual(liveTurns(failed, [msg("brief")], true), []);
});

test("liveTurns never shows an abandoned call as streaming", () => {
  // Worker killed mid-review of a; a resumed worker reviews a again (call 3).
  const s = run(withOffsets([
    start(1, "p", "generate", 1), end(1), start(2, "a", "review", 1), delta(2, "old"), start(3, "a", "review", 1), delta(3, "new"),
  ]));
  assert.deepEqual(liveTurns(s, [msg("r1-proposal")], true).map((t) => [t.call, t.phase]), [[3, "streaming"]]);
  // Killed mid-revision, then a different call starts: the partial revision is shown interrupted.
  const r = run(withOffsets([start(1, "p", "revise", 1), delta(1, "x"), start(2, "a", "review", 2)]));
  assert.deepEqual(liveTurns(r, [], true).map((t) => [t.call, t.phase]), [[1, "interrupted"], [2, "streaming"]]);
  // Not active: the partial text stays, marked interrupted.
  const dead = run(withOffsets([start(1, "p", "generate", 1), delta(1, "half")]));
  assert.deepEqual(liveTurns(dead, [], false).map((t) => [t.call, t.phase, t.text]), [[1, "interrupted", "half"]]);
  assert.deepEqual(liveTurns(dead, [msg("r1-proposal")], false), []);
});

test("liveTurns drops a finished call superseded by a retry of the same turn", () => {
  const s = run(withOffsets([start(1, "a", "review", 1), delta(1, "bad json"), end(1), start(2, "a", "review", 1)]));
  assert.deepEqual(liveTurns(s, [], true).map((t) => [t.call, t.phase]), [[2, "streaming"]]);
});

test("liveTurns keeps a finished revision's proposal while a same-round follow-up asks for missing answers", () => {
  const s = run(withOffsets([
    start(1, "p", "revise", 1), delta(1, '{"proposal": "New plan", "dispositions": []}'), end(1),
    start(2, "p", "revise", 1), delta(2, '{"dispositions": [{"issue_ref": "a:1"'),
  ]));
  const turns = liveTurns(s, [msg("r1-proposal")], true);
  assert.deepEqual(turns.map((t) => [t.call, t.phase, t.proposal, t.followUp]), [[2, "streaming", "New plan", true]]);
  // A follow-up that does write a proposal shows its own.
  const own = run(withOffsets([
    start(1, "p", "revise", 1), delta(1, '{"proposal": "Old"}'), end(1),
    start(2, "p", "revise", 1), delta(2, '{"proposal": "Retry'),
  ]));
  assert.deepEqual(liveTurns(own, [], true).map((t) => [t.call, t.proposal, t.followUp]), [[2, "Retry", undefined]]);
  // Once the formatted revision lands, neither is shown.
  assert.deepEqual(liveTurns(s, [msg("r1-revision")], true), []);
});

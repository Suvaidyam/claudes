import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboxItem } from "../src/inbox.js";
import type { Review } from "../src/schema.js";
import type { RunState } from "../src/store.js";
import { buildConversation } from "../src/ui/conversation.js";

const issue = (id: string, severity: "blocker" | "major" | "minor" = "major") =>
  ({ id, severity, category: "other", finding: `finding ${id}`, recommendation: `fix ${id}` });
const rv = (score: number, ids: string[]): Review =>
  ({ score, confidence: 0.8, summary: `score ${score}`, strengths: [], issues: ids.map((i) => issue(i)) });

/** A legacy run: no live log, no worker file, no maxRounds/inboxConsumed, `continuedAt: true`. */
function legacy(): RunState {
  return {
    id: "legacy", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    status: "max_rounds", statusDetail: "Reached max rounds (3)", brief: "# Sync\nBuild it",
    primary: "claude", secondaries: ["agy", "codex"],
    scenarios: [{ id: "S1", text: "Device offline for a week", addedRound: 2 }],
    rounds: [
      {
        round: 1, proposal: "P1", reviews: { agy: rv(5, ["X-1", "X-2"]), codex: rv(6, ["Y-1"]) },
        meanScore: 5.5, minScore: 5, blockers: 0,
        revision: {
          proposal: "P2",
          dispositions: [
            { issue_ref: "A:X-1", action: "accepted", rationale: "ok" },
            { issue_ref: "A:X-2", action: "accepted", rationale: "ok" },
            { issue_ref: "B:Y-1", action: "rejected", rationale: "no" },
          ],
        },
      },
      {
        round: 2, proposal: "P2", reviews: { agy: rv(6, []), codex: rv(7, []) }, meanScore: 6.5, minScore: 6, blockers: 0,
        continuedAt: true, humanFeedback: "Think about cost",
        reopened: [{ ref: "r1:agy:X-1", issue: issue("X-1") }],
        revision: { proposal: "P3", dispositions: [{ issue_ref: "OWNER:1", action: "partial", rationale: "some" }] },
      },
      { round: 3, proposal: "P3", reviews: { agy: rv(7, []), codex: rv(7, []) }, meanScore: 7, minScore: 7, blockers: 0 },
    ],
  };
}

test("buildConversation renders a legacy run", () => {
  const msgs = buildConversation(legacy(), [], false);
  assert.deepEqual(msgs.map((m) => m.kind), [
    "brief", "proposal", "review", "review", "round_divider",
    "revision", "review", "review", "round_divider",
    "owner", "revision", "review", "review", "round_divider", "end",
  ]);
  assert.equal(new Set(msgs.map((m) => m.key)).size, msgs.length, "keys are unique");
  assert.deepEqual(msgs.slice(2, 4).map((m) => [m.key, m.name, m.speaker]), [
    ["r1-review-agy", "agy", "reviewer"], ["r1-review-codex", "codex", "reviewer"],
  ]);
  const [rev1, rev2] = msgs.filter((m) => m.kind === "revision");
  assert.deepEqual(rev1!.dispositions, { accepted: 2, partial: 0, rejected: 1, answered: 3, total: 3 });
  assert.equal(rev1!.markdown, "P2");
  assert.equal(rev1!.name, "claude");
  assert.deepEqual(rev2!.dispositions, { accepted: 0, partial: 1, rejected: 0, answered: 1, total: 1 });
  const owner = msgs.find((m) => m.kind === "owner")!;
  assert.equal(owner.round, 2);
  assert.deepEqual(owner.owner, {
    scenarios: ["S1: Device offline for a week"], reopened: ["r1:agy:X-1"], note: "Think about cost",
  });
  const end = msgs[msgs.length - 1]!;
  assert.equal(end.end!.status, "max_rounds");
  assert.deepEqual(end.end!.actions, ["continue", "branch", "report"]);
});

test("queued items appear with the right status", () => {
  const queued: InboxItem[] = [{ type: "note", text: "Also GDPR", ts: "2026-01-01T00:00:00.000Z#1" }];
  const idle = buildConversation(legacy(), queued, false);
  const q = idle[idle.length - 2]!;
  assert.equal(q.kind, "queued");
  assert.equal(q.status, "Queued · will be used when you continue");
  assert.equal(q.owner!.note, "Also GDPR");
  assert.equal(idle[idle.length - 1]!.kind, "end");

  // While a worker is active the run hasn't ended, so there is no end card: the queued item is last.
  const running = { ...legacy(), status: "running" as const };
  const active = buildConversation(running, queued, true);
  const qa = active[active.length - 1]!;
  assert.equal(qa.kind, "queued");
  assert.equal(qa.status, "Queued · used in the next revision");
});

test("+N rounds already applied early are not shown as queued while the run is active", () => {
  const more: InboxItem = { type: "more", n: 2, ts: "2026-01-01T00:00:00.000Z#2" };
  const note: InboxItem = { type: "note", text: "later", ts: "2026-01-01T00:00:00.000Z#3" };
  const running = { ...legacy(), status: "running" as const, inboxMoreApplied: [more.ts] };
  const queued = buildConversation(running, [more, note], true).filter((m) => m.kind === "queued");
  assert.deepEqual(queued.map((m) => m.owner!.note ?? m.owner!.more), ["later"]);
});

test("an interrupted run ends with a resume card", () => {
  const msgs = buildConversation({ ...legacy(), status: "running" }, [], false);
  const end = msgs[msgs.length - 1]!;
  assert.equal(end.kind, "end");
  assert.ok(end.end!.actions.includes("resume"));
});

test("a stopped run can be continued or resumed", () => {
  const msgs = buildConversation({ ...legacy(), status: "stopped" }, [], false);
  assert.deepEqual(msgs[msgs.length - 1]!.end!.actions, ["continue", "resume", "branch", "report"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../../../src/ui/types";
import { EMPTY_DRAFT, isNearBottom, messageBody, optimisticMessages, withOptimistic } from "./composer";

test("messageBody sends the text as a note, plus scenarios, reopened issues and extra rounds", () => {
  assert.equal(messageBody(EMPTY_DRAFT), undefined);
  assert.equal(messageBody({ ...EMPTY_DRAFT, text: "  \n " }), undefined);
  assert.deepEqual(messageBody({ ...EMPTY_DRAFT, text: "Think about cost\n" }), { note: "Think about cost\n" });
  assert.deepEqual(
    messageBody({ text: "", scenarios: ["Offline a week"], reopen: ["r1:A:X-1"], more: 3 }),
    { scenarios: ["Offline a week"], reopen: ["r1:A:X-1"], more: 3 },
  );
  assert.deepEqual(messageBody({ ...EMPTY_DRAFT, more: 1 }), { more: 1 });
});

test("optimisticMessages shows each part of a message as a queued bubble", () => {
  const msgs = optimisticMessages({ note: "n", scenarios: ["s"], reopen: ["r1:A:X-1"], more: 2 }, 3, "Queued", "k");
  assert.deepEqual(msgs.map((m) => [m.kind, m.round, m.status, m.owner]), [
    ["queued", 3, "Queued", { scenarios: [], reopened: [], note: "n" }],
    ["queued", 3, "Queued", { scenarios: ["New: s"], reopened: [] }],
    ["queued", 3, "Queued", { scenarios: [], reopened: ["r1:A:X-1"] }],
    ["queued", 3, "Queued", { scenarios: [], reopened: [], more: 2 }],
  ]);
  assert.equal(new Set(msgs.map((m) => m.key)).size, 4);
});

const m = (key: string, kind: ChatMessage["kind"]): ChatMessage => ({ key, speaker: "you", name: "", round: 1, status: "", kind });

test("withOptimistic puts pending bubbles after the queued items and before the end card", () => {
  const pending = [m("o1", "queued")];
  assert.deepEqual(withOptimistic([m("a", "proposal"), m("q", "queued"), m("end", "end")], pending).map((x) => x.key), ["a", "q", "o1", "end"]);
  assert.deepEqual(withOptimistic([m("a", "proposal")], pending).map((x) => x.key), ["a", "o1"]);
  const base = [m("a", "proposal")];
  assert.equal(withOptimistic(base, []), base);
});

test("isNearBottom allows a little slack", () => {
  assert.equal(isNearBottom({ scrollTop: 560, scrollHeight: 1000, clientHeight: 400 }), true);
  assert.equal(isNearBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 400 }), false);
});

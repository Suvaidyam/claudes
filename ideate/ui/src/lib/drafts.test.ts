import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_DRAFT, type Draft } from "./composer";
import { clearSent, clearSentText, draftKey, loadDraft, loadText, saveDraft, saveText, settleSent, settleSentText, type DraftStorage } from "./drafts";

function fakeStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

const broken: DraftStorage = {
  getItem: () => { throw new Error("denied"); },
  setItem: () => { throw new Error("quota"); },
  removeItem: () => { throw new Error("denied"); },
};

test("a draft survives a remount: saved per idea, restored on load", () => {
  const s = fakeStorage();
  const d: Draft = { text: "half typed", scenarios: ["Offline"], reopen: ["r1:a:X-1"], more: 3 };
  saveDraft(s, draftKey("idea-1"), d);
  assert.deepEqual(loadDraft(s, draftKey("idea-1")), d);
  assert.deepEqual(loadDraft(s, draftKey("idea-2")), EMPTY_DRAFT);
  saveText(s, draftKey("new"), "a brief");
  assert.equal(loadText(s, draftKey("new")), "a brief");
  // Empty drafts are removed rather than stored.
  saveDraft(s, draftKey("idea-1"), EMPTY_DRAFT);
  saveText(s, draftKey("new"), "");
  assert.equal(s.data.size, 0);
});

test("no or broken storage: drafts fall back to empty and nothing throws", () => {
  assert.deepEqual(loadDraft(undefined, "k"), EMPTY_DRAFT);
  assert.deepEqual(loadDraft(broken, "k"), EMPTY_DRAFT);
  assert.equal(loadText(broken, "k"), "");
  saveDraft(broken, "k", { ...EMPTY_DRAFT, text: "x" });
  saveText(undefined, "k", "x");
  settleSent(broken, "k", { ...EMPTY_DRAFT, text: "x" });
  settleSentText(broken, "k", "x");
  const s = fakeStorage();
  s.data.set("k", "{not json");
  assert.deepEqual(loadDraft(s, "k"), EMPTY_DRAFT);
  s.data.set("k", JSON.stringify({ text: 5 }));
  assert.deepEqual(loadDraft(s, "k"), EMPTY_DRAFT);
});

test("after a send only what was sent is cleared", () => {
  const sent: Draft = { text: "note", scenarios: ["A"], reopen: ["r1:a:X-1"], more: 2 };
  assert.deepEqual(clearSent(sent, sent), EMPTY_DRAFT);
  // Typed more while the send was in flight: the newer text stays, plus anything added since.
  assert.deepEqual(
    clearSent({ text: "note and more", scenarios: ["A", "B"], reopen: ["r1:a:X-1", "r1:b:Y-1"], more: 4 }, sent),
    { text: "note and more", scenarios: ["B"], reopen: ["r1:b:Y-1"], more: 4 },
  );
  assert.equal(clearSentText("brief", "brief"), "");
  assert.equal(clearSentText("brief, edited", "brief"), "brief, edited");
});

test("settleSent clears the stored draft even when the composer is gone", () => {
  const s = fakeStorage();
  saveDraft(s, "k", { ...EMPTY_DRAFT, text: "sent" });
  settleSent(s, "k", { ...EMPTY_DRAFT, text: "sent" });
  assert.equal(s.data.has("k"), false);
  saveDraft(s, "k", { ...EMPTY_DRAFT, text: "sent then more" });
  settleSent(s, "k", { ...EMPTY_DRAFT, text: "sent" });
  assert.equal(loadDraft(s, "k").text, "sent then more");
  saveText(s, "n", "brief");
  settleSentText(s, "n", "brief");
  assert.equal(s.data.has("n"), false);
});

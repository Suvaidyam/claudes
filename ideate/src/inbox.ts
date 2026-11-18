/**
 * The owner's inbox: input sent while a run is working (notes, scenario changes, reopened issues,
 * extra rounds). Appended to runs/<id>/inbox.jsonl by whoever receives it; the run's loop reads it
 * from `state.inboxConsumed` and applies it with `applyInbox`.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { addScenario, editScenario, findIssue, removeScenario } from "./ideas.js";
import { endsMidLine, readJsonl } from "./jsonl.js";
import type { RoundRecord, RunState } from "./store.js";

export type InboxItem = (
  | { type: "note"; text: string }
  | { type: "add_scenario"; text: string }
  | { type: "edit_scenario"; id: string; text: string }
  | { type: "remove_scenario"; id: string }
  | { type: "reopen"; ref: string }
  | { type: "more"; n: number }
) & { ts: string };

const InboxItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("note"), text: z.string() }),
  z.object({ type: z.literal("add_scenario"), text: z.string() }),
  z.object({ type: z.literal("edit_scenario"), id: z.string(), text: z.string() }),
  z.object({ type: z.literal("remove_scenario"), id: z.string() }),
  z.object({ type: z.literal("reopen"), ref: z.string() }),
  z.object({ type: z.literal("more"), n: z.number().int().positive() }),
]);

const FILE = "inbox.jsonl";

export function appendInbox(runDir: string, item: InboxItem): void {
  const path = join(runDir, FILE);
  appendFileSync(path, (endsMidLine(path) ? "\n" : "") + JSON.stringify(item) + "\n");
}

/** Items from byte `fromOffset`, with the same partial- and torn-line rules as `readLive`. */
export function readInbox(runDir: string, fromOffset: number): { items: InboxItem[]; offset: number } {
  const { values, offset } = readJsonl(join(runDir, FILE), fromOffset);
  return { items: values as InboxItem[], offset };
}

/**
 * Applies items to the run and `round` (the round about to be revised). Returns one line per item;
 * an item that can't be applied (bad shape, unknown scenario or issue) is reported as "Skipped: …"
 * and never throws. `more` adds to `state.maxRounds` (the caller sets it first on legacy runs).
 */
export function applyInbox(state: RunState, round: RoundRecord, items: InboxItem[]): string[] {
  const r = round.round;
  return items.map((raw) => {
    const parsed = InboxItemSchema.safeParse(raw);
    if (!parsed.success) return `Skipped: invalid inbox item ${oneLine(JSON.stringify(raw))}`;
    const it = parsed.data;
    try {
      switch (it.type) {
        case "note": {
          const text = it.text.trim();
          if (!text) throw new Error("empty note");
          round.humanFeedback = round.humanFeedback ? `${round.humanFeedback}\n\n${text}` : text;
          return `Note for the next revision: ${oneLine(text)}`;
        }
        case "add_scenario": {
          const sc = addScenario(state, r, it.text);
          return `Added ${sc.id}: ${oneLine(sc.text)}`;
        }
        case "edit_scenario":
          return `Edited ${editScenario(state, r, it.id, it.text).id}`;
        case "remove_scenario":
          return `Removed ${removeScenario(state, r, it.id).id}`;
        case "reopen": {
          const hit = findIssue(state, it.ref);
          const list = (round.reopened ??= []);
          if (list.some((o) => o.ref === hit.ref)) return `Already reopened ${hit.ref}`;
          list.push(hit);
          return `Reopened ${hit.ref}: ${oneLine(hit.issue.finding)}`;
        }
        case "more":
          state.maxRounds = (state.maxRounds ?? r) + it.n;
          return `Up to ${it.n} more round(s): limit now ${state.maxRounds}`;
      }
    } catch (e) {
      return `Skipped: ${it.type} — ${(e as Error).message}`;
    }
  });
}

const oneLine = (t: string, n = 100) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

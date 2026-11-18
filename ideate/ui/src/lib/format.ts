import type { RunSummary } from "../../../src/ideas";
import type { Issue } from "../../../src/schema";
import type { Speaker } from "../../../src/ui/types";

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Sidebar suffix: "✓ 8.5" once converged, otherwise "r5 · 6.0". */
export function rowMeta(row: RunSummary): string {
  if (row.status === "converged" && row.lastMean !== undefined) return `✓ ${row.lastMean.toFixed(1)}`;
  if (!row.rounds) return "";
  return row.lastMean === undefined ? `r${row.rounds}` : `r${row.rounds} · ${row.lastMean.toFixed(1)}`;
}

/** Branches read "r2: <title>" after the round they were branched from. */
export const rowLabel = (row: RunSummary): string => (row.parent && row.depth > 0 ? `r${row.parent.fromRound}: ${row.title}` : row.title);

export const scoreChip = (mean: number, blockers: number): string => `mean ${mean.toFixed(1)} · ${plural(blockers, "blocker")}`;

const REVIEWER_COLORS = ["#4285f4", "#10a37f"];
const GREY = "#9a9a9a";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Round avatar: the primary in Claude orange; reviewers lettered A, B, … in config order. */
export function avatar(speaker: Speaker, name: string, secondaries: string[]): { letter: string; color: string } {
  if (speaker === "primary") return { letter: (name[0] ?? "?").toUpperCase(), color: "#d97757" };
  const i = secondaries.indexOf(name);
  if (i < 0) return { letter: (name[0] ?? "?").toUpperCase(), color: GREY };
  return { letter: LETTERS[i] ?? "?", color: REVIEWER_COLORS[i] ?? GREY };
}

const RANK = { blocker: 0, major: 1, minor: 2 } as const;

/** Blockers then majors are shown; minors sit behind "+N more". */
export function splitIssues(issues: Issue[]): { shown: Issue[]; minors: Issue[] } {
  const sorted = [...issues].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return { shown: sorted.filter((i) => i.severity !== "minor"), minors: sorted.filter((i) => i.severity === "minor") };
}

/**
 * The first `max` lines, cut back to a paragraph break in the second half so a table or list isn't
 * split; with `maxChars`, also at most that many characters (a pasted brief can be one huge line).
 */
export function clipLines(text: string, max: number, maxChars = Infinity): { text: string; clipped: boolean } {
  const lines = text.split("\n");
  let out = text;
  if (lines.length > max) {
    let end = max;
    for (let i = max - 1; i >= max / 2; i--) {
      if (!lines[i]?.trim()) { end = i; break; }
    }
    out = lines.slice(0, end).join("\n");
  }
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const at = [cut.lastIndexOf("\n\n"), cut.lastIndexOf("\n"), cut.lastIndexOf(" ")].find((i) => i >= maxChars / 2);
    out = cut.slice(0, at ?? maxChars).trimEnd();
  }
  return { text: out, clipped: out !== text };
}

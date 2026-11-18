import { ideaTitle, LABELS, OWNER_LABEL } from "./ideas.js";
import type { Issue } from "./schema.js";
import type { RoundRecord, RunState } from "./store.js";

export function renderReport(s: RunState): string {
  const last = s.rounds[s.rounds.length - 1];
  // The newest round may not have been reviewed yet (e.g. the run failed or paused mid-review).
  const lastReviewed = [...s.rounds].reverse().find((r) => r.meanScore !== undefined);
  const lines: string[] = [];

  lines.push(`# ${ideaTitle(s)}`, "", `**Run:** ${s.id}`);
  if (s.parent) lines.push(`**Branched from:** ${s.parent.id}, round ${s.parent.fromRound}`);
  lines.push(`**Status:** ${s.status}${s.statusDetail ? ` — ${s.statusDetail}` : ""}`);
  lines.push(`**Primary:** ${s.primary} · **Reviewers:** ${s.secondaries.join(", ")}`, "");

  lines.push("## Score trajectory", "", "| Round | Mean | Min | Blockers | " + s.secondaries.join(" | ") + " |");
  lines.push("|---|---|---|---|" + s.secondaries.map(() => "---|").join(""));
  for (const r of s.rounds) {
    if (r.meanScore === undefined) continue;
    const per = s.secondaries.map((n) => r.reviews[n]?.score.toFixed(1) ?? "—").join(" | ");
    lines.push(`| ${r.round} | ${r.meanScore.toFixed(1)} | ${r.minScore!.toFixed(1)} | ${r.blockers} | ${per} |`);
  }

  if (lastReviewed) {
    const open = Object.entries(lastReviewed.reviews).flatMap(([n, rv]) => rv.issues.map((i) => ({ n, ...i })));
    lines.push("", `## Open issues from the latest review (round ${lastReviewed.round}, ${open.length})`, "");
    if (!open.length) lines.push("None.");
    for (const sev of ["blocker", "major", "minor"] as const) {
      for (const i of open.filter((x) => x.severity === sev)) {
        lines.push(`- **${sev}** [${i.n}:${i.id}] (${i.category}) ${i.finding} → ${i.recommendation}`);
      }
    }
  }

  const scenarios = s.scenarios ?? [];
  if (scenarios.length) {
    lines.push("", "## Scenarios", "");
    for (const sc of scenarios) {
      const when = `added r${sc.addedRound}${sc.editedRound ? `, edited r${sc.editedRound}` : ""}${sc.removedRound ? `, removed r${sc.removedRound}` : ""}`;
      lines.push(sc.removedRound ? `- ~~${sc.id}: ${sc.text}~~ (${when})` : `- **${sc.id}**: ${sc.text} (${when})`);
    }
  }

  const reopened = s.rounds.flatMap((r) => (r.reopened ?? []).map((o, i) => ({ r, o, ref: `${OWNER_LABEL}:${i + 1}` })));
  if (reopened.length) {
    lines.push("", "## Issues you reopened", "");
    for (const { r, o, ref } of reopened) {
      const d = r.revision?.dispositions.find((x) => x.issue_ref === ref);
      lines.push(`- r${r.round} ${o.ref} (${o.issue.severity}) ${o.issue.finding}\n  ${d ? `${d.action}: ${d.rationale}` : r.revision ? "Never answered by the primary." : "Not revised yet."}`);
    }
  }

  // Disposition refs use anonymous labels ("A:SEC-1"); show the provider and the issue text instead.
  const describe = (r: RoundRecord, ref: string) => {
    const [label, id] = splitRef(ref);
    if (label === OWNER_LABEL) {
      const o = r.reopened?.[Number(id) - 1];
      return o ? `${o.ref} (reopened, ${o.issue.severity}) ${o.issue.finding}` : ref;
    }
    const name = s.secondaries[LABELS.indexOf(label)];
    const issue: Issue | undefined = name ? r.reviews[name]?.issues.find((i) => i.id === id) : undefined;
    return `${name ?? label}:${id}${issue ? ` (${issue.severity}) ${issue.finding}` : ""}`;
  };

  const rejected = s.rounds.flatMap((r) =>
    (r.revision?.dispositions ?? []).filter((d) => d.action === "rejected").map((d) => ({ r, d })),
  );
  if (rejected.length) {
    lines.push("", "## Feedback the primary rejected (check these yourself)", "");
    for (const { r, d } of rejected) lines.push(`- r${r.round} ${describe(r, d.issue_ref)}\n  Rejected because: ${d.rationale}`);
  }

  const undisposed = s.rounds.flatMap((r) => (r.undisposed ?? []).map((ref) => ({ r, ref })));
  if (undisposed.length) {
    lines.push("", "## Issues the primary never answered (check these yourself)", "");
    for (const { r, ref } of undisposed) lines.push(`- r${r.round} ${describe(r, ref)}`);
  }

  if (last) {
    lines.push("", "---", "", `## Final proposal (round ${last.round})`, "");
    if (last !== lastReviewed) {
      lines.push(
        lastReviewed
          ? `> This proposal has not been reviewed yet. The open issues above are from round ${lastReviewed.round}.`
          : "> This proposal has not been reviewed yet.",
        "",
      );
    }
    lines.push(last.proposal);
  }
  return lines.join("\n") + "\n";
}

function splitRef(ref: string): [string, string] {
  const i = ref.indexOf(":");
  return i === -1 ? ["", ref] : [ref.slice(0, i), ref.slice(i + 1)];
}

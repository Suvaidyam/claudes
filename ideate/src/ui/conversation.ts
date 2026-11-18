/**
 * The chat view of a run, derived from state.json (never stored): the brief, each round's
 * proposal or revision, the reviews, the owner's input at continue points, queued inbox items
 * and an end card. The turn in progress comes from live.jsonl on the front end.
 */
import type { InboxItem } from "../inbox.js";
import { labelOf, OWNER_LABEL } from "../ideas.js";
import type { RoundRecord, RunState } from "../store.js";
import type { ChatMessage } from "./types.js";

type EndAction = NonNullable<ChatMessage["end"]>["actions"][number];

export function buildConversation(state: RunState, queued: InboxItem[], active: boolean): ChatMessage[] {
  const out: ChatMessage[] = [];
  const primary = state.primary;
  out.push({ key: "brief", speaker: "you", name: "You", round: 0, status: "Brief", kind: "brief", markdown: state.brief });

  for (const r of state.rounds) {
    const n = r.round;
    const prev = state.rounds[n - 2];
    // Round 1's proposal, or a round whose predecessor has no revision on record.
    if (n === 1 || !prev?.revision) {
      out.push({ key: `r${n}-proposal`, speaker: "primary", name: primary, round: n, status: `Proposal · round ${n}`, kind: "proposal", markdown: r.proposal });
    }
    for (const reviewer of state.secondaries) {
      const review = r.reviews[reviewer];
      if (!review) continue;
      out.push({
        key: `r${n}-review-${reviewer}`, speaker: "reviewer", name: reviewer, round: n,
        status: `Review · round ${n} · ${review.score}/10`, kind: "review",
        review: { score: review.score, summary: review.summary, issues: review.issues },
      });
    }
    if (r.meanScore !== undefined) {
      out.push({
        key: `r${n}-divider`, speaker: "system", name: "", round: n, kind: "round_divider",
        status: `Round ${n} · mean ${r.meanScore.toFixed(1)} · ${r.blockers ?? 0} blocker${r.blockers === 1 ? "" : "s"}`,
      });
    }
    const owner = ownerInput(state, r);
    if (owner) {
      out.push({ key: `r${n}-owner`, speaker: "you", name: "You", round: n, status: `Before the revision of round ${n}`, kind: "owner", owner });
    }
    if (r.revision) {
      const d = dispositions(state, r);
      out.push({
        key: `r${n}-revision`, speaker: "primary", name: primary, round: n, kind: "revision",
        status: `Revision of round ${n} · answered ${d.answered}/${d.total} issues · accepted ${d.accepted} · partial ${d.partial} · rejected ${d.rejected}`,
        markdown: r.revision.proposal, dispositions: d,
      });
    }
  }

  const round = state.rounds.length;
  const queuedStatus = active ? "Queued · used in the next revision" : "Queued · will be used when you continue";
  // While running, `more` items applied early already raised the limit: they aren't waiting.
  const early = new Set(active ? state.inboxMoreApplied ?? [] : []);
  queued.forEach((item, i) => {
    if (item.type === "more" && early.has(item.ts)) return;
    out.push({ key: `queued-${item.ts}-${i}`, speaker: "you", name: "You", round, status: queuedStatus, kind: "queued", owner: queuedInput(item) });
  });

  if (!active) out.push(endCard(state));
  return out;
}

/** What the owner gave the revision of round `r`: scenario changes, reopened issues, note, extra rounds. */
function ownerInput(state: RunState, r: RoundRecord): ChatMessage["owner"] | undefined {
  const n = r.round;
  const scenarios: string[] = [];
  for (const s of state.scenarios ?? []) {
    if (s.addedRound === n) scenarios.push(`${s.id}: ${s.text}`);
    else if (s.editedRound === n) scenarios.push(`${s.id} (edited): ${s.text}`);
    if (s.removedRound === n) scenarios.push(`${s.id} (removed)`);
  }
  const reopened = (r.reopened ?? []).map((o) => o.ref);
  const note = r.humanFeedback?.trim() || undefined;
  const more = typeof r.continuedAt === "object" ? r.continuedAt.more : undefined;
  if (!scenarios.length && !reopened.length && !note && more === undefined && !r.continuedAt) return undefined;
  return { scenarios, reopened, ...(note ? { note } : {}), ...(more !== undefined ? { more } : {}) };
}

function dispositions(state: RunState, r: RoundRecord): NonNullable<ChatMessage["dispositions"]> {
  const refs = [
    ...state.secondaries.flatMap((name) => (r.reviews[name]?.issues ?? []).map((i) => `${labelOf(state, name)}:${i.id}`)),
    ...(r.reopened ?? []).map((_, i) => `${OWNER_LABEL}:${i + 1}`),
  ];
  const all = r.revision?.dispositions ?? [];
  const count = (a: string) => all.filter((d) => d.action === a).length;
  return {
    accepted: count("accepted"), partial: count("partial"), rejected: count("rejected"),
    answered: refs.filter((ref) => all.some((d) => d.issue_ref === ref)).length,
    total: refs.length,
  };
}

function queuedInput(item: InboxItem): NonNullable<ChatMessage["owner"]> {
  const o: NonNullable<ChatMessage["owner"]> = { scenarios: [], reopened: [] };
  switch (item.type) {
    case "note": o.note = item.text; break;
    case "add_scenario": o.scenarios.push(`New: ${item.text}`); break;
    case "edit_scenario": o.scenarios.push(`${item.id} (edited): ${item.text}`); break;
    case "remove_scenario": o.scenarios.push(`${item.id} (removed)`); break;
    case "reopen": o.reopened.push(item.ref); break;
    case "more": o.more = item.n; break;
  }
  return o;
}

function endCard(state: RunState): ChatMessage {
  const reviewed = state.rounds.some((r) => r.meanScore !== undefined);
  const branch: EndAction[] = reviewed ? ["branch"] : [];
  let actions: EndAction[];
  let detail = state.statusDetail;
  switch (state.status) {
    case "running": // no live process: interrupted
      detail = "No process is working on this idea";
      actions = ["resume", ...branch, "report"];
      break;
    case "failed":
    case "paused_quota":
      actions = ["resume", ...branch, "report"];
      break;
    default: {
      const cont: EndAction[] = state.rounds.length ? ["continue"] : [];
      // A stopped run can also pick up exactly where it was stopped.
      actions = [...cont, ...(state.status === "stopped" ? (["resume"] as EndAction[]) : []), ...branch, "report"];
    }
  }
  return {
    key: "end", speaker: "system", name: "", round: state.rounds.length, kind: "end",
    status: state.status === "running" ? "interrupted" : state.status,
    end: { status: state.status, ...(detail ? { detail } : {}), actions },
  };
}

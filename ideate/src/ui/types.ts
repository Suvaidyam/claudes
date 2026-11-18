/** Shapes the `ideate ui` server sends to the front end (type-only imports from ui/). */
import type { InboxItem } from "../inbox.js";
import type { PastIssue, RunSummary } from "../ideas.js";
import type { Issue } from "../schema.js";
import type { RunState, RunStatus } from "../store.js";

export type Speaker = "you" | "primary" | "reviewer" | "system";

export interface ChatMessage {
  /** Stable across refreshes, e.g. "r3-review-agy". */
  key: string;
  speaker: Speaker;
  name: string;
  round: number;
  status: string;
  kind: "brief" | "proposal" | "revision" | "review" | "owner" | "queued" | "round_divider" | "end";
  markdown?: string;
  review?: { score: number; summary: string; issues: Issue[] };
  dispositions?: { accepted: number; partial: number; rejected: number; answered: number; total: number };
  owner?: { scenarios: string[]; reopened: string[]; note?: string; more?: number };
  end?: { status: RunStatus; detail?: string; actions: ("continue" | "branch" | "resume" | "report")[] };
}

export interface IdeaDetail {
  summary: RunSummary;
  state: RunState;
  messages: ChatMessage[];
  queued: InboxItem[];
  issues: PastIssue[];
  maxRounds: number;
}

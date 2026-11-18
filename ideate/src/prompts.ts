import { JSON_SHAPES, type Disposition, type Issue, type Review } from "./schema.js";
import type { Scenario } from "./store.js";

export interface PriorIssue {
  issue: Issue;
  disposition?: Disposition;
}

/** A past issue the owner reopened, as shown to the primary ("[OWNER:1]") and to reviewers. */
export interface OwnerIssue {
  ref: string;
  issue: Issue;
  disposition?: Disposition;
}

export const DEFAULT_RUBRIC = [
  "Correctness: does it actually solve the stated problem? Hidden assumptions?",
  "Scale: what breaks at 10x and 100x load, data, tenants, countries?",
  "Security & privacy: authn/z, data protection, threat surface, compliance",
  "Operational complexity: deploy, observe, upgrade, on-call burden, skills required",
  "Cost: build, run, and 10-year total cost of ownership",
  "Maintainability & lock-in: open standards, portability, exit cost",
  "Simpler alternative: is there a materially simpler design that gets 80% of the value?",
];

export interface PromptContext {
  brief: string;
  context?: string;
  rubric: string[];
  /** Active owner-added scenarios. */
  scenarios?: Scenario[];
}

/** `newAt`: scenarios added or edited in this round are marked NEW, so the reader knows to look for them. */
const ctxBlock = (c: PromptContext, newAt?: number) =>
  [
    `# Problem brief\n${c.brief}`,
    c.context ? `# Constraints and context\n${c.context}` : "",
    c.scenarios?.length
      ? `# Scenarios the design must handle\n${c.scenarios
          .map((s) => {
            const isNew = newAt !== undefined && (s.addedRound === newAt || s.editedRound === newAt);
            return `- ${s.id}${isNew ? " (NEW this round)" : ""}: ${s.text}`;
          })
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

export function generatePrompt(c: PromptContext): string {
  return `You are the lead architect. Produce a concrete, opinionated proposal for the brief below.

${ctxBlock(c)}

Requirements:
- Start with the recommendation, then the design, then trade-offs and risks.
- State assumptions explicitly.
- Prefer concrete choices over option lists.
- Output markdown only. No preamble.`;
}

/**
 * Reviewers see an anonymous proposal: no model names, no "another AI wrote this".
 * Attribution measurably softens critique.
 */
export function reviewPrompt(
  c: PromptContext,
  proposal: string,
  round: number,
  priorIssues: PriorIssue[] | undefined,
  ownerIssues: OwnerIssue[] = [],
): string {
  // The CLIs are stateless, so the reviewer must be shown what it raised last round,
  // not just the author's verdicts, or it cannot judge whether a rejection holds.
  const prior = priorIssues?.length
    ? `\n# Your issues from the previous round, and the author's response\n${priorIssues
        .map(({ issue: i, disposition: d }) =>
          `- ${i.id} (${i.severity}, ${i.category}): ${i.finding}\n  You recommended: ${i.recommendation}\n  Author: ` +
          (d ? `${d.action.toUpperCase()} — ${d.rationale}` : "NO RESPONSE (the author did not address this issue)"),
        )
        .join("\n")}\n\nCheck the revised proposal against each one. Re-raise an issue (same id) if it is still present, ` +
      `if the rejection rationale is weak, or if the author did not respond. Drop it if it is genuinely resolved.\n`
    : "";

  const owner = ownerIssues.length
    ? `\n# Issues the owner reopened last round, and the author's response\n${ownerIssues
        .map(({ ref, issue: i, disposition: d }) =>
          `- ${ref} (${i.severity}, ${i.category}): ${i.finding}\n  Recommended: ${i.recommendation}\n  Author: ` +
          (d ? `${d.action.toUpperCase()} — ${d.rationale}` : "NO RESPONSE"),
        )
        .join("\n")}\n\nThe owner wants these settled. If the revised proposal does not resolve one, raise it as your own issue.\n`
    : "";
  const scenarioRule = c.scenarios?.length
    ? `\nCheck that the proposal handles every scenario listed above. For each one it does not handle, raise an issue with category "scenario" whose finding starts with the scenario id (e.g. "S1: ...").\n`
    : "";

  return `You are a skeptical principal engineer doing an adversarial design review (round ${round}).
Your job is to find what is wrong, missing, or risky — not to be agreeable.
Do not invent issues to fill space; a short list of real issues beats a long list of trivia.

${ctxBlock(c, round - 1)}

# Rubric
${c.rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}

# Proposal under review
${proposal}
${prior}${owner}${scenarioRule}
# Scoring
- 9-10: ready to build; only minor issues.
- 7-8: sound, with major issues that need fixing.
- 4-6: significant gaps or a blocker.
- 0-3: wrong approach.
Use severity "blocker" only for issues that would make the design fail or be unsafe in production.

Respond with ONLY a JSON object of this shape, no prose:
${JSON_SHAPES.review}`;
}

export function revisePrompt(
  c: PromptContext,
  proposal: string,
  round: number,
  reviews: { label: string; review: Review }[],
  humanFeedback?: string,
  ownerIssues: OwnerIssue[] = [],
): string {
  const ownerText = ownerIssues.length
    ? `\n# Issues the human owner reopened from earlier rounds (must be addressed)\n${ownerIssues
        .map(({ ref, issue: i }) => `- [${ref}] (${i.severity}, ${i.category}) ${i.finding}\n  → ${i.recommendation}`)
        .join("\n")}\n`
    : "";
  const reviewText = reviews
    .map(
      ({ label, review }) =>
        `## Reviewer ${label} — score ${review.score}/10 (confidence ${review.confidence})\n${review.summary}\n` +
        review.issues
          .map((i) => `- [${label}:${i.id}] (${i.severity}, ${i.category}) ${i.finding}\n  → ${i.recommendation}`)
          .join("\n"),
    )
    .join("\n\n");

  return `ROUND ${round}. You are the lead architect and author of the proposal below.
Independent reviewers have critiqued it. Revise the proposal.

${ctxBlock(c, round)}

# Current proposal
${proposal}

# Reviews
${reviewText}
${ownerText}${humanFeedback ? `\n# Feedback from the human owner (highest priority)\n${humanFeedback}\n` : ""}
Rules:
- Address every issue, including reopened ones. Give each an explicit disposition: accepted, partial, or rejected.${c.scenarios?.length ? "\n- The revised proposal must handle every scenario listed above; say where each is handled." : ""}
- Rejecting is allowed when the reviewer is wrong — give a concrete technical rationale. Do not accept everything to please reviewers.
- Where reviewers conflict, pick one and say why.
- Return the FULL revised proposal, not a diff.

Respond with ONLY a JSON object of this shape, no prose:
${JSON_SHAPES.revision}`;
}

/** Asks only for the missing dispositions, so the proposal itself isn't regenerated. */
export function missingDispositionsPrompt(
  round: number,
  missing: { ref: string; issue: Issue }[],
): string {
  return `ROUND ${round}. Your revision did not give a disposition for these review issues:

${missing.map(({ ref, issue: i }) => `- [${ref}] (${i.severity}) ${i.finding}`).join("\n")}

Give each one an explicit disposition: accepted, partial, or rejected, with a concrete rationale.
Use the exact issue_ref shown in brackets (without the brackets).

Respond with ONLY a JSON object of this shape, no prose:
${JSON_SHAPES.dispositions}`;
}

// A revision carries the whole proposal; truncating it here would make the repaired answer lose text.
const REPAIR_ECHO_LIMIT = 200_000;

export function repairPrompt(shape: string, badOutput: string, error: string): string {
  return `Your previous response could not be parsed (${error}).
Return ONLY a valid JSON object of this shape, with no prose and no code fences:
${shape}

Previous response:
${badOutput.slice(0, REPAIR_ECHO_LIMIT)}`;
}

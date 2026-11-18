import { z } from "zod";

export const Severity = z.enum(["blocker", "major", "minor"]);

export const Issue = z.object({
  id: z.string().describe("Short stable id, e.g. SEC-1"),
  severity: Severity,
  category: z.string(), // security | scale | ops | cost | correctness | assumption | other
  finding: z.string(),
  recommendation: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const Review = z.object({
  score: z.number().min(0).max(10),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  strengths: z.array(z.string()).default([]),
  issues: z.array(Issue).default([]),
});
export type Review = z.infer<typeof Review>;

export const Disposition = z.object({
  issue_ref: z.string().describe("reviewer:issueId"),
  action: z.enum(["accepted", "partial", "rejected"]),
  rationale: z.string(),
});
export type Disposition = z.infer<typeof Disposition>;

/** Follow-up answer when the primary skipped some issues. */
export const Dispositions = z.object({
  dispositions: z.array(Disposition).min(1),
});

export const Revision = z.object({
  proposal: z.string().describe("Full revised proposal, markdown"),
  dispositions: z.array(Disposition).default([]),
});
export type Revision = z.infer<typeof Revision>;

export const JSON_SHAPES = {
  review: `{
  "score": <0-10 number>,
  "confidence": <0-1 number>,
  "summary": "<2-3 sentences>",
  "strengths": ["..."],
  "issues": [
    {"id": "SEC-1", "severity": "blocker|major|minor", "category": "security|scale|ops|cost|correctness|assumption|other",
     "finding": "...", "recommendation": "..."}
  ]
}`,
  revision: `{
  "proposal": "<the FULL revised proposal in markdown>",
  "dispositions": [
    {"issue_ref": "<reviewer>:<issueId>", "action": "accepted|partial|rejected", "rationale": "..."}
  ]
}`,
  dispositions: `{
  "dispositions": [
    {"issue_ref": "<reviewer>:<issueId>", "action": "accepted|partial|rejected", "rationale": "..."}
  ]
}`,
};

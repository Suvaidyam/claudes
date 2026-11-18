---
name: review
description: Send a plan, design doc or spec, exactly as written, to the other models (agy and Codex by default) for an adversarial review, then check their findings against the code and revise. Use when the user says "ideate review", "review it first", "review this plan with ideate", "get the plan reviewed by agy and codex", "review again", or invokes /ideate:review.
argument-hint: "[file] [--reviewers a,b]"
---

# ideate:review

You wrote the plan in this session and know the codebase. The reviewers see only the plan's text.
This skill gets their critique of the plan as written; no other model rewrites it. You then judge
each finding and revise the plan yourself.

## 1. Pick the plan

- A path in the arguments: use it.
- No path: the plan or design doc most recently written or discussed in this conversation. Say which
  one you picked. If there is none, ask.
- A plan that exists only in the conversation (for example one just presented from plan mode):
  write it, complete and unabridged, to a file in the scratchpad directory and use that.

Resolve to an absolute path and check it exists.

Plan mode allows read-only actions only, and a review writes a run folder. If plan mode is still
on, tell the user to answer "review it first" in place of approving, and run once it is off.

The text is sent to every reviewer's vendor (the reviewers are set in the `config.json` in ideate's
data home; `ideate` prints its location when it creates it). If it plainly contains patient,
partner or government data, or secrets, stop and tell the user instead of running.

## 2. Start the review in the background

Every command here is `ideate ...` from PATH. If `ideate` is not found, tell the user to run
`./setup.sh` in their `claude_pool` clone, and stop.

Build the run ID first, in its own command, so you know it: `date +review-%Y%m%d-%H%M%S`.

```bash
ideate run \
  --id "<run id>" \
  --title "Review: <file name>" \
  --proposal "@<absolute path>" \
  --rounds 1
```

- `--proposal` makes the file round 1's proposal as written. `--rounds 1` ends the run after the
  reviews, so the config's primary is never called. Always pass both.
- Add `--brief "<one or two sentences: what the plan is for and what it must achieve>"` when you
  know it. Reviewers judge the plan against the brief; without one a generic brief is used.
- Add `--context "@<file>"` only for constraints the plan doesn't state itself.
- Pass `--reviewers a,b` through if the user gave it.

Run with `run_in_background: true`; each reviewer can take several minutes. At the end of the run
the CLI prints a line `Report: <path>` on stderr; that is the report's path. Tell the user it has
started, the run ID, and that it is visible live at http://127.0.0.1:4317 if `ideate ui` is running.
Do not poll; wait for the completion notification.

## 3. Read the result

| Exit code | Meaning | What to do |
|---|---|---|
| 0 | Every reviewer passed the plan | Report |
| 2 | Reviews are in, not all passed | The normal outcome of a one-round review. Not a failure |
| 75 | Paused on a usage limit | Say which reviewer, and that `ideate resume <id>` retries just the missing review |
| 1 | Error | Show the error from the output |

Then read the report at the path from the `Report: <path>` line, or run `ideate report <id>` to print
it. Each reviewer's full critique is in `review-<name>.json` under `round-1/` in the run folder
(the report's folder).

## 4. Judge each finding against the code

The reviewers have not seen the codebase. Before repeating any finding, check it: read the code it
is about. Sort every issue into one of:

- **Real**: the plan has this problem. Say what you would change.
- **Already handled**: the code or the plan covers it. Name where.
- **Not worth it**: true in general, wrong for this project's scale or goals. Say why.

## 5. Report and revise

Lead with each reviewer's score. Then a table of the issues, blockers and majors first: the
finding in a line, which reviewer, your verdict, and your reason. Then the list of changes you
propose to make to the plan.

Apply those changes to the plan only after the user agrees, or straight away if they already asked
for the plan to be revised after review. Never start implementing the plan from this skill: after
revising, present the plan again for approval.

## Reviewing again

Each review is a fresh run on the current text; reviewers do not see what they raised last time.
When the user asks to review again after a revision, run the same steps on the revised file, and
say in your report which of the earlier issues came back.

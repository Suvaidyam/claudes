# Chat UI for ideation-loop — design

Date: 2026-11-13 · Status: reviewed, awaiting owner approval · Branch: `feature/chat-ui` (on top of `feature/manage-ideas`)

## Intent

`ideate` already runs the loop (Claude writes a proposal, agy and codex review it, Claude revises) and,
with `feature/manage-ideas`, can list ideas and continue them with new scenarios, reopened issues and
branches. Everything happens in the terminal, and a run's output only becomes visible when each agent
call finishes, minutes later.

The owner wants to use the tool the way they use Claude or ChatGPT: a sidebar of past conversations,
one conversation per idea, the agents' text appearing live as they write, and a message box to steer.
It is a personal tool on their own Mac.

## Goals

1. A local web app, started with `ideate ui`, that looks and feels like a chat app (layout "A" from the
   brainstorm, below).
2. Every agent's output streams into the conversation as it is written.
3. Everything the CLI can do with ideas is doable from the app: start an idea, continue it with
   scenarios / reopened issues / a note / more rounds, branch from an earlier round, resume an
   interrupted run, stop a run, read the final proposal.
4. Runs started from the terminal and from the app are the same thing and appear in both.

## Anti-goal (the one the owner named)

**Never lose a run or any output because the browser was closed.** Closing the tab, the browser
crashing, or stopping `ideate ui` must not stop a run or lose any text an agent has already written.
Reopening the app shows everything written so far and keeps streaming. This is a hard requirement and
must be covered by tests (see Verification).

## Non-goals

- Other users, logins, remote access, hosting. The app binds to `127.0.0.1` only.
- Mobile layout. Desktop browser widths only; it must not break on a narrow window, nothing more.
- Editing or deleting past messages; deleting ideas; comparing branches side by side.
- Recording the owner's own decision on an idea (accepted/parked). Later.
- Windows/Linux-specific work. macOS is the target; don't use anything that obviously breaks elsewhere.
- Replacing the CLI. The CLI stays fully usable.

## Decisions made with the owner

- **Layout A: one message per agent, in order**, like a group chat (mockup:
  `.superpowers/brainstorm/84516-1794509718/content/chat-layout.html`, option A).
  - Left sidebar: ideas like chat history, grouped by date (Today / Previous 7 days / Older), branches
    nested under their parent, `＋ New idea` at the top.
  - Header: idea title, round "n of max", mean score and blockers, scenario count.
  - Conversation: avatar + name + status line per message ("Claude · revising round 4 · answered 6/6",
    "agy · reviewer · round 5 · 7.0/10", "codex · thinking…"). Long messages collapse.
  - Composer at the bottom: free text plus buttons `＋ Scenario`, `↺ Reopen issue`, `⑂ Branch`,
    `Rounds: N`, send.
- **Personal, local use.** `ideate ui` starts the server and opens the browser; Ctrl-C stops it.
- **Runs keep running in the background** when the tab closes or `ideate ui` stops, and the app shows
  them when reopened.
- **New idea = type the brief like a chat message.** No form.
- **A queued message that never reaches a revision is kept and used on the next continue.** If a run
  ends (converged, round limit, stagnated, stopped, failed) with unconsumed inbox items, they stay
  queued; the next `continue` or `resume` of that idea, from the app or the terminal, applies them
  before its first revision. The conversation shows them as "Queued · will be used when you continue".
  Nothing is ever silently dropped.

## Decisions I made (owner may revisit)

- **Same repo and package.** Server code in `src/ui/`, front end in `ui/` (React + Vite + TypeScript),
  built into `dist/ui` by `npm run build`. Uses the same `config.json` and `runs/` as the CLI.
- **Title** defaults to the brief's first line (existing `ideaTitle`); click the header title to rename.
- **Agents and rounds** default to `config.json`. A small settings popover next to send can override
  rounds and reviewers for a new idea. Never required.
- **Messages typed while agents are working are queued** for the next revision, not interrupting.
- **A Stop button** while a run is active (like ChatGPT's stop). Stopping sets status `stopped`; the
  idea can be continued later.
- **Every run is a worker, wherever it was started.** Streaming to `live.jsonl`, the `worker.json`
  heartbeat, reading the inbox and SIGTERM → `stopped` apply to all `run`/`continue`/`resume`
  processes, not only `--worker` ones, so terminal runs show live in the app and are never mistaken
  for interrupted. `--worker` only means "started by the app": no stdin prompting, output to
  `worker.log`. With `-i` in the terminal, inbox notes and the typed answer both reach Claude
  (inbox first, then the typed text).
- **One process per idea, enforced.** `continue` and `resume` refuse (not just warn) when the idea is
  active by the liveness rule. A pid that is alive with a stale heartbeat also counts as active.
- **Each run stores its own round limit.** New optional `RunState.maxRounds`, set by `run`
  (config or `--rounds`), `continue` (`fromRound + more`) and the app's settings; `+N rounds` sent to
  an active run raises it live (inbox item `more`). `resume` uses `state.maxRounds` when present, else
  today's behaviour (config / `--rounds`), so old runs and existing flags behave as before. Continue
  points record their `more` (e.g. `RoundRecord.continuedAt` becomes `{ more }`, still truthy) so the
  conversation can show "+N rounds".
- Live log, worker and inbox formats below.

## How it works

### 1. Runs are separate processes ("workers")

The app never runs the loop inside its own server. To start, continue or resume, the server spawns the
CLI itself (`node dist/cli.js run|continue|resume … --worker`) as a detached process
(`detached: true`, own process group, stdout/stderr to `runs/<id>/worker.log`, `unref()`). That is
what keeps runs alive when the browser or `ideate ui` goes away, and it means terminal and app runs
behave identically.

`--worker` (new flag, also usable from the terminal) makes the process:
- write `runs/<id>/worker.json` = `{ pid, startedAt, heartbeatAt, command }` and refresh `heartbeatAt`
  every 5 s;
- on SIGTERM: finish writing, set status `stopped` with detail "Stopped from the app", checkpoint,
  exit (in-flight agent calls are killed; their partial text is already in the live log);
- read the inbox (below) before each revision;
- never prompt on stdin (no `-i`).

The server needs to know the new run's ID right away: the CLI's `run` command takes an optional
`--id <id>` (server generates it with `RunStore.newId()`); `continue --from-round` likewise takes
`--branch-id <id>`.

**Liveness.** An idea is *active* if `worker.json` exists, its pid is alive (`process.kill(pid, 0)`)
and `heartbeatAt` is under 30 s old. If `state.status` is `running` but the idea isn't active, it is
**interrupted** (Mac slept, rebooted, process killed): the UI shows "Interrupted · Resume", and Resume
spawns `ideate resume <id> --worker`. One worker per idea: starting a second one while the first is
active is refused (server checks, and the CLI refuses too, using the same liveness rule).

### 2. Everything an agent writes goes to disk as it arrives

New file `runs/<id>/live.jsonl`, append-only, one JSON event per line, flushed per event:

```
{"t":"call_start","call":17,"provider":"agy","role":"review","round":5,"ts":"…"}
{"t":"delta","call":17,"text":"…"}            // text as it streams, already unwrapped from the CLI's own format
{"t":"call_end","call":17,"ok":true,"ms":104210,"ts":"…"}   // ok:false + "error" on failure
```

`call` is a per-run counter continued across processes (read the last `call` on startup). The existing
`state.json` checkpoints and `raw/transcript.jsonl` stay as they are; `live.jsonl` is purely for live
display, and the final, parsed results still come from `state.json`.

### 3. Streaming from each CLI

`CommandProvider.complete()` today buffers stdout and resolves at exit. Add an `onDelta(text)` callback
and a per-provider `stream` parser in `config.json`, which turns the CLI's streaming output into text
deltas *and* still yields the final text for the existing parsing:

| Provider | Args change | Parser |
|---|---|---|
| claude | `--output-format stream-json --verbose --include-partial-messages` (replaces `json`) | text deltas from partial assistant message events; final result from the `{"type":"result",…}` line (same fields as today: `result`, `is_error`, `subtype`, `api_error_status`) |
| agy | none (already `stream-json`) | `step_update.text_delta`; final from the `result` event (already parsed) |
| codex | `exec --json` | agent message events; final message text |
| other / mock | — | no deltas; whole output at the end (mock may emit fake deltas for tests) |

These flags exist in the installed versions (claude 2.1.322, codex 0.159.3, agy 1.5.6), but the exact
event shapes must be captured from real runs and pinned in tests before relying on them. `envelopeError`
and `extractText` must keep working on the new formats (extend `parseEnvelope` for Claude's and
Codex's NDJSON). If a CLI's stream format can't be parsed, fall back to no deltas, never to a failed
call.

### 4. The inbox: steering while agents work

`runs/<id>/inbox.jsonl`, appended by the server, consumed by the worker. Item types mirror
`ContinuePlan`: `note`, `add_scenario`, `edit_scenario`, `remove_scenario`, `reopen`, plus `more`
(raises `state.maxRounds` immediately, checked by the stop rule). Before each revision the loop applies
all unconsumed items to the current round (notes concatenate into `humanFeedback`; scenarios via
`addScenario`/…; reopen via `findIssue`), records them as consumed (`state.inboxConsumed` = byte
offset), checkpoints, then revises. Items that arrive during a revision apply to the next one.

Items still unconsumed when a run ends stay in the inbox. `continue` and `resume` apply them (together
with any flags or wizard input) to the round they start from, before its revision, so they are never
lost. The server writes to the inbox only when the idea is active; otherwise sending starts
`ideate continue <id> --worker` with the plan, which also picks up anything left in the inbox. If the
worker exits between the server's liveness check and its append, the item simply waits for the next
continue, which is the same outcome.

### 5. Server (`ideate ui`)

`node:http` (no framework needed), `127.0.0.1`, default port 4317 (`--port`), opens the browser
unless `--no-open`. Serves the built front end and a JSON API; live updates via Server-Sent Events.

- `GET  /api/ideas` → `listRuns()` rows + `active` / `interrupted` flags.
- `GET  /api/ideas/:id` → the run's `state.json` plus derived conversation (see 6).
- `GET  /api/ideas/:id/live?from=<byte offset>` (SSE) → replays `live.jsonl` from the offset, then tails
  it; also emits `state` whenever `state.json` changes. Reconnects resume from the last offset, so a
  closed tab misses nothing.
- `POST /api/ideas` `{ brief, title?, rounds?, reviewers? }` → spawn `run --worker`, return id.
- `POST /api/ideas/:id/messages` `{ note?, scenarios?, reopen?, more? }` → inbox if active, else spawn
  `continue --worker`.
- `POST /api/ideas/:id/branch` `{ fromRound, … }`, `POST /api/ideas/:id/resume`,
  `POST /api/ideas/:id/stop`, `PATCH /api/ideas/:id` `{ title }`.
- `GET  /api/ideas/:id/report` → `renderReport()` markdown.

Reuse, don't duplicate: `listRuns`, `pastIssues`, `prepareContinue` (via the spawned CLI), `renderReport`,
`ideaTitle`, `RunStore`. Requests that change a run go through the CLI process, so there is one writer
per run at a time; the only file the server itself appends to is `inbox.jsonl` (and the title, which
must be written while no worker is active, or sent through the inbox if one is).

### 6. Conversation model (derived, not stored)

Built from `state.json` (completed turns) + `live.jsonl` (the turn in progress):

1. **You**: the brief.
2. Per round *r*:
   - **Claude**: round 1 proposal (markdown), or the revision of round *r−1* with a line "answered
     N/M issues · accepted a · partial p · rejected j", expandable to the full proposal and dispositions.
   - **agy**, **codex**: score, summary, issues grouped by severity (blockers and majors shown,
     "+N more" for minors), expandable.
   - Round divider with mean / blockers.
3. **You** messages at continue points, derived from state: scenarios added/edited/removed at that
   round, reopened issues, the note (`humanFeedback`), "+N rounds". Inbox items not yet consumed show
   as **You** messages marked "Queued · used in the next revision" (run active) or "Queued · will be
   used when you continue" (run ended).
4. Status/footer card when the run stopped: why (converged / max rounds / stagnated / stopped /
   failed / interrupted) and what you can do (continue, branch, resume), plus "View final proposal".

Streaming display: proposals stream as markdown. Reviews and revisions are JSON from the model; while
streaming, show the extracted `proposal` string for revisions (decode the partial JSON string field
progressively) and a dimmed raw preview for reviews; swap to the formatted card when the call ends.

### 7. Front end

React + Vite + TypeScript in `ui/`. Markdown via a maintained renderer (e.g. `react-markdown`); no
heavy UI kit. Pin dependency versions that are at least two weeks old. Light theme matching the mockup;
dark mode follows the OS if cheap. Keyboard: Enter sends, Shift+Enter newline.

## Constraints

- Node ≥ 20, TypeScript strict, ESM, existing `tsc` build plus a Vite build step.
- Existing runs (no `live.jsonl`, no `worker.json`) must open fine: they show from `state.json` only.
- CLI behaviour, flags and exit codes stay backward compatible; all existing tests keep passing.
- CLI calls take minutes (timeouts 600 s); the UI must never assume a call is quick.
- Don't send anything outside localhost; no telemetry, no CDNs at runtime (bundle assets).

## Left to the builder

Component structure, styling details, state management, whether to use `fs.watch` or polling for
tailing (must work reliably on macOS), exact SSE event names, port default, how the partial-JSON
`proposal` decoder is written, test tooling for the front end.

## Verification

1. Unit: stream parsers for claude/codex/agy against captured real output; live log writing and
   replay from an offset; inbox application before a revision; liveness/interrupted detection;
   conversation derivation from a real `state.json` (the CHW run).
2. **Durability (the anti-goal):** with the mock provider emitting slow deltas: start a run from the
   API, kill the SSE client mid-call, kill the `ideate ui` server, restart it, reconnect: the run is
   still active, and the replayed text equals everything written so far plus the rest, with no gaps
   or duplicates. Kill the worker with SIGKILL: the idea shows Interrupted, Resume finishes it.
3. Stop from the UI sets `stopped` and the idea can be continued.
4. Queued-at-the-end: send a note during the final round's reviews; the run ends at its limit; the note
   shows as queued; `ideate continue <id>` from the terminal uses it in its first revision.
5. Resume of an interrupted continued run uses `state.maxRounds`, not the config's.
6. A terminal `ideate run` shows as active and streams live in the app; the app refuses to start a
   second process on it.
7. Manual, real CLIs: start an idea in the app, watch all three agents stream, close the tab, reopen,
   add a scenario mid-review, confirm it is used in the next revision; start an idea from the terminal
   and watch it live in the app.

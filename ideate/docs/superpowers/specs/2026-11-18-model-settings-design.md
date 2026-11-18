# Model settings screen — design

Date: 2026-11-18 · Status: awaiting owner approval · Builds on the chat UI (`docs/superpowers/specs/2026-11-13-chat-ui-design.md`)

## Intent

Today, who writes and who reviews is set by hand in `config.json`, and the server reads that file once
at startup. The owner wants to choose these in the chat app instead, and in particular to run the whole
loop on Claude alone, with a different Claude model in each role (for example Sonnet writes, Fable and
Opus review).

The owner chose the narrow version ("option 1"): pick roles from a known list. The app must never
accept a command line from the browser, because the server has no login and a provider is a shell
command.

## Goals

1. A Settings screen in the app where the owner picks the writer, the reviewers and the loop numbers,
   and saves them as the defaults for new ideas.
2. Claude Fable, Opus, Sonnet and Haiku are each selectable as a separate writer or reviewer, with no
   hand-editing of `config.json`.
3. Saving takes effect for the next idea without restarting `ideate ui`.
4. The CLI sees the same result: `ideate run` after a save uses the saved writer and reviewers.

## Non-goals

- Adding or editing providers from the app (raw command, arguments, input mode, env). Still done in
  `config.json`.
- Choosing a model for Codex or agy. Each has one entry that uses the CLI's own default model.
- Changing the writer or reviewers of an existing idea. Each idea keeps the ones it started with.
- Choosing the writer per idea in the New Idea popover. That popover keeps its current scope (rounds,
  and which of the default reviewers to use).
- Changing `runsDir` or the rubric from the app.
- Logins or remote access.

## Anti-goals

- **No command line crosses the HTTP API.** The save endpoint accepts provider *names* and numbers
  only. Nothing a browser sends may end up as a `cmd`, `args` or `env` value.
- **A save must not break an existing idea.** Resuming or continuing an older idea must work after
  any save, whatever it selected.
- **A save must not damage `config.json`.** Hand-written provider entries and any keys the app doesn't
  know about survive a save unchanged. A crash mid-save must not leave a half-written file.

## Approaches considered

1. **Built-in model list in code — chosen (Claude's call; the owner left the how open).** The tool
   ships a catalogue of known providers. The config loader merges it under the file's own `providers`.
   The Settings screen writes only `primary`, `secondaries` and `loop`. Command lines never pass through
   the browser and stay current when the tool is updated.
2. **Copy provider entries into `config.json` on save.** No change to config loading, but copied
   command lines go stale when flags change. The README already has a paragraph telling people to
   re-copy streaming flags by hand for exactly this reason.
3. **Per-idea picker only.** Extend the New Idea popover and pass `--primary` / `--reviewers`.
   Smaller, but nothing is saved as a default, loop numbers stay file-only, and the providers would
   still need to exist somewhere.

## Design

### Built-in catalogue

A new module (suggested `src/catalogue.ts`) exports the built-in providers:

| Name | Label | Command |
|---|---|---|
| `claude-fable` | Claude Fable | the example config's `claude` args plus `--model fable` |
| `claude-opus` | Claude Opus | same, `--model opus` |
| `claude-sonnet` | Claude Sonnet | same, `--model sonnet` |
| `claude-haiku` | Claude Haiku | same, `--model haiku` |
| `codex` | Codex | exactly the example config's `codex` entry |
| `agy` | agy | exactly the example config's `agy` entry |

Model aliases, not dated model ids, so each entry follows the newest model of that tier. `claude
--help` confirms `fable`, `opus` and `sonnet`; the builder should confirm `haiku` is accepted and drop
that row if it isn't.

Each entry also carries a `family` (`claude`, `codex`, `agy`) used for the hint below.

`loadConfig` merges the catalogue under the file's `providers`: a name defined in the file wins. So
the owner's existing `claude`, `codex` and `agy` entries keep working exactly as they are, and a
config file with no `providers` key at all becomes valid (make `providers` default to `{}`).

Label, family and source for the screen (Claude's calls, after the reviewer's read):

- The owner's current `config.json` already defines `claude`, `codex` and `agy`. A file entry that
  shadows a catalogue name runs the file's command but keeps the catalogue's label and family, and
  its `source` is `config.json`. The screen marks it "(from config.json)".
- Any other file-defined command provider gets its name as its label, and a family inferred from the
  basename of its `cmd` when that is `claude`, `codex` or `agy`. So today's writer, the file's
  `claude`, has family `claude` and the hint works for it. Anything else has no family.
- This metadata is derived by a function next to the catalogue, not stored on `Config`.

### What the server offers

`GET /api/settings` returns:

- `primary`, `secondaries`, and the `loop` numbers currently in effect
- `providers`: every selectable name (catalogue plus the file's own), each with `label`, `family`
  (absent for file-defined ones), `source` (`built-in` or `config.json`) and `available`

`available` is whether the provider's `cmd` is found on `PATH`, checked when the endpoint is called.
Mock providers are always available. The check is injectable through `ServerOptions` so tests don't
depend on which CLIs are installed.

The existing `GET /api/config` stays, and reads the reloaded config.

### Saving

`PUT /api/settings` takes `{ primary, secondaries, loop }` and rejects (400, with a message the screen
shows) when:

- any name isn't in the selectable list
- the writer is also a reviewer, there are no reviewers, a reviewer repeats, or there are more than 26
- a *newly selected* provider isn't available (so the owner can't save a setup that fails on the
  first call)
- a *changed* number is out of range: `maxRounds` 1–20, `passScore` 0–10, `maxBlockers` ≥ 0,
  `timeoutSec` 30–3600, `stagnationRounds` ≥ 1, `minDelta` ≥ 0

Availability and ranges apply only to what the save changes, compared with the config on disk
(Claude's call). A provider that is already selected but not installed, or a hand-set number outside
these ranges, doesn't block an unrelated save. `loadConfig` is not tightened: hand-edited files and
the CLI keep today's limits.

Unknown keys in the body are rejected, not ignored.

The server re-reads `config.json` from disk as raw JSON, sets only `primary`, `secondaries` and the
six `loop` keys above, and validates the merged result with the same schema and checks `loadConfig`
uses (split a parse-an-object function out of `loadConfig` for this). Only if that passes does it
write to a temp file and rename it over the original, the same pattern the run checkpoint uses. If
the file on disk is not valid JSON, or the merged result fails validation (for example because of a
hand edit made since startup), the save fails with a clear message and writes nothing.

Everything else in the file is left as it was, including `providers`, `rubric`, `runsDir`,
`loop.repairAttempts` and any key the app doesn't know.

After a successful write the server swaps its in-memory config, which also adopts hand edits made
to `providers` and `rubric` since startup. `runsDir` stays pinned to its startup value until
`ideate ui` is restarted (Claude's call): switching it mid-session would empty the sidebar and
orphan the tracking of workers already started.

The existing same-origin check covers the new endpoints.

### What a save affects

- **New ideas** use the new writer, reviewers and loop numbers.
- **Running ideas** are untouched: a worker read the config when it started.
- **Existing ideas** keep their own writer and reviewers (stored in each run's state). Nothing is
  ever removed from the selectable list by a save, so their providers still resolve.
- **Loop numbers other than rounds** (pass score, blockers, timeout, stagnation) are read from the
  config whenever a worker starts, so an older idea that is resumed or continued after a save uses
  the new numbers. Rounds are stored per idea and don't change. This is how the tool already
  behaves when the file is edited by hand; the screen should say so in one line.

### The screen

A gear at the bottom of the sidebar opens Settings in the main pane (a view, not a popover: it has
more controls than fit one).

```
Settings                                   Defaults for new ideas

Writer        (•) Claude Sonnet   ( ) Claude Fable   ( ) Claude Opus
              ( ) Claude Haiku    ( ) Codex          ( ) agy
              ( ) claude  (from config.json)

Reviewers     [x] Claude Fable    [x] Claude Opus    [ ] Claude Haiku
              [ ] Codex           [ ] agy — not installed
              (Claude Sonnet is the writer)

              ⓘ All reviewers are Claude, like the writer. Models from one
                family share blind spots and one usage limit.

Rounds        [ 3 ]        Pass score   [ 8 ]     Open blockers allowed [ 0 ]
Timeout (s)   [ 600 ]

▸ Advanced    Stop after [ 2 ] rounds without a [ 0.25 ] improvement

              Running ideas aren't affected. Ideas you continue later keep
              their writer and reviewers but use these loop numbers.

                                                     [ Cancel ]  [ Save ]
```

- The current writer can't be ticked as a reviewer. Choosing a writer that is ticked as a reviewer
  unticks it.
- Unavailable providers are marked "not installed" and can't be newly selected. One that is already
  selected stays selectable so it can be unticked or left as it is.
- The family hint appears when every reviewer has the same known family as the writer. It is
  advice, not a block.
- Save is disabled until something changed and there is at least one reviewer. A server rejection
  appears next to the Save button.
- After a save, the New Idea popover shows the new defaults without a page reload.

### Docs

README: a short "Settings" paragraph in the Chat UI section, and a line under "Adding a provider"
saying the built-in names exist and that a same-named entry in `config.json` overrides one.

## Verification

- Config loading: catalogue names resolve with no `providers` in the file; a file entry of the same
  name wins; the existing example and mock configs load unchanged.
- Save endpoint: each rejection above; unknown keys rejected; a body carrying `cmd`/`args` is
  rejected; other file keys and hand-written providers survive a save byte-for-meaning; the file is
  never left half-written.
- Reload: after a save, `GET /api/config` reflects it and a new idea started through the API runs
  with the new writer and reviewers (mock providers).
- An idea created before a save can still be resumed and continued after it.
- Front-end logic that isn't trivial (writer/reviewer exclusion, the family hint, dirty check) lives
  in `ui/src/lib` with unit tests, like the existing helpers there.
- Run the app and save a Claude-only setup once for real before calling it done.

## Left to the builder

- File and component names, route for the Settings view, and styling, following the existing UI.
- How `PATH` lookup is done.
- Exact wording of labels, hints and error messages.
- Whether the six loop fields are validated with a shared zod schema on both sides.

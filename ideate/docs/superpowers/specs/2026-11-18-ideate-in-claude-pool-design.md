# ideate as part of claude_pool — design

Date: 2026-11-18 · Status: awaiting owner approval

Repos: `Suvaidyam/ideation-loop` (this one, at `<old ideation-loop clone>`) and
`Medtronic-LABS/claude_pool` (at `<claude_pool clone>`, the source of the `claudes` command).

## Intent

The owner and their teammates install `claudes` from `claude_pool` with `./setup.sh`. The ideation
tool (`ideate`) and its `/ideate-review` command are a separate repo with a separate install: clone,
`npm install`, build, `npm link`, and a hand-made link per profile. The command file also hard-codes
this Mac's path to the repo.

The owner wants the tool to be part of `claudes`: whoever runs the `claudes` setup gets `ideate` and
`/ideate-review` in every profile, with no second installation. The owner decided the tool's code
moves into the `claude_pool` repo.

## Goals

1. After `./setup.sh` in `claude_pool`, on a machine with Node 20+ and the `claude` CLI:
   - `/ideate-review` is available in every `claudes` profile, from any project.
   - `ideate` works from any terminal folder (`ideate ui`, `ideate run`, `ideate list`).
2. No `npm install`, build step or network access is needed on the machine doing the setup.
3. One place for the tool's config and runs, whichever folder or profile it is used from.
4. The tool's source, tests and docs live in `claude_pool` and can still be developed and tested
   there.
5. On the owner's Mac, existing ideas and config carry over.

## Non-goals

- Installing or logging in to agy and Codex. They are other vendors' CLIs. Setup reports whether
  each is found and nothing more.
- Installing Node.
- Covering a plain `claude` (the default `~/.claude` config) that hasn't been folded into the shared
  layer with `claudes migrate`.
- Updating the tool automatically when `claudes` is launched. Updates arrive by pulling
  `claude_pool` and running `./setup.sh` again.
- Publishing to a public plugin marketplace.
- Windows.
- The model settings screen (`2026-11-18-model-settings-design.md`). It is a separate, still
  unapproved design. It moves with the code and is built later, in the new location.

## Anti-goals

- **`claudes` setup must never fail or stall because of the tool.** Missing Node, a missing `claude`
  CLI, or a failed plugin install prints one clear line and setup carries on. Account switching is
  what `claude_pool` is for.
- **The Python side stays as it is:** standard library only, no build step. Nothing about the Node
  project may be needed to run `claudes`.
- **No machine-specific paths** in anything committed.
- **No loss of the owner's existing runs.** Migration copies; it never moves or deletes.
- **Never touch live state in the `claude_pool` working tree** (`accounts.json`, `profiles/`), and
  leave the owner's uncommitted edits to `claudes.py` (in `launch` and `_login`) alone.

## Approaches considered

**Where the code lives** (the owner's decision): keep it in `Suvaidyam/ideation-loop` and have
`claudes` pull it in, or move it into `claude_pool`. The owner chose to move it: one repo and one
access list for the team, at the cost of a Node project inside a Python tool's repo.

**How it reaches every profile** (Claude's call):

1. **A Claude Code plugin, installed by `claudes install` — chosen.** `claudes` already shares each
   profile's `plugins` folder and `settings.json` through `~/.claudes/shared`, and plugin installs
   are recorded in exactly those two places. One install therefore covers every profile. Checked on
   this Mac in a throwaway config folder: `claude plugin marketplace add <folder>` followed by
   `claude plugin install ideate@claude-pool` succeeds with no login and copies the plugin into the
   config's `plugins/cache`.
2. **Link the skill into each profile's `skills` folder.** That is today's stopgap. `skills` is not a
   shared folder, so every new profile needs a new link, and `claudes` would have to maintain them.
3. **Build on the user's machine during setup.** Needs npm, network access and about 90 MB of
   dependencies, and gives setup many more ways to fail. Ruled out by goal 2.

## Design

### Layout in `claude_pool`

```
claude_pool/
  claudes.py  setup.sh  README.md  SETUP.md  ...     unchanged in nature
  .claude-plugin/marketplace.json                    this repo as a plugin source named "claude-pool"
  ideate/                                            the moved project
    src/  ui/  test/  docs/  package.json  tsconfig.json  config.example.json  config.mock.json
  plugins/ideate/                                    the installable plugin (committed, built output)
    .claude-plugin/plugin.json
    skills/ideate-review/SKILL.md
    bin/ideate.mjs                                   the CLI bundled into one file
    web/                                             the built front end
    config.example.json
```

The code is brought across with its git history (`git subtree add --prefix=ideate`), after
`feature/review-own-plan` is merged into `main` here so the `--proposal` flag and the skill come
along. Claude's call; the owner may prefer a single squashed commit if this repo's history shouldn't
enter the other organisation's repo.

`Suvaidyam/ideation-loop` is left as it is. Retiring it or pointing its README at the new home is
the owner's to do.

### The committed build

`plugins/ideate/bin/ideate.mjs` and `plugins/ideate/web/` are build output, committed so that a
machine needs only Node to run them (Claude's call; goal 2 depends on it).

- A new script in `ideate/` (suggested `npm run bundle`) builds both from source into
  `plugins/ideate/`. The CLI and its dependencies become one ES module; esbuild is the suggested
  bundler, added as a dev dependency.
- A check (suggested `npm run bundle:check`, also part of `npm test`) rebuilds into a temp folder and
  fails if the result differs from what is committed. Anyone changing `ideate/src` or `ideate/ui`
  re-runs the bundle and commits it.
- The bundle must be reproducible on one machine: no timestamps or absolute paths in its output, or
  the check is useless.

Two places in the tool find files relative to their own module and must keep working from the
bundle: the server's static folder (`UI_DIR` in `src/ui/server.ts`, today `../../dist/web/`) and the
command it uses to start workers (`defaultCliCommand` in `src/ui/spawn.ts`, today `dist/cli.js`).
From the bundle these are `../web/` and the bundle file itself. Running from source under `tsx` and
from `dist/` must keep working as today.

### Where the tool keeps its data

Today `config.json` and the `runs/` folder are found relative to whatever folder the command runs
in. That changes:

- **Home folder:** `IDEATE_HOME` if set, else `<claudes base>/shared/ideate`, where the claudes base
  is `CLAUDES_BASE` if set, else `~/.claudes`. So by default `~/.claudes/shared/ideate/`. It sits in
  `shared/` because it is shared across profiles, and because `shared/` is already gitignored for
  setups where the base is the `claude_pool` clone itself (where `ideate/` is the source folder).
- **Config:** `--config <path>` if given, else `<home>/config.json`. If that file doesn't exist it
  is created from the bundled `config.example.json`, and the tool says so in one line.
- **Runs:** a relative `runsDir` resolves against the folder holding the config file, not the
  working folder. The default stays `runs`, so runs land in `~/.claudes/shared/ideate/runs/`.
- A `config.json` in the working folder is no longer picked up on its own. Working on the tool in
  the repo uses `--config` or `IDEATE_HOME`; the `demo` script already passes `--config`.

The server's worker processes are started with the resolved absolute config path, as today.

### What `claudes install` does

After its existing steps, `install()` in `claudes.py` sets up the tool. Each step that can't be done
prints one line and the rest of install continues.

1. **Copy the plugin source into the base.** `.claude-plugin/marketplace.json` and `plugins/` are
   copied to `<base>/marketplace/`, replacing what was there. This mirrors how `claudes.py` itself
   is copied to `<base>/claudes`, so the clone can be moved or deleted afterwards.
2. **Check Node.** If `node` is missing or older than 20, say so and skip the remaining steps.
3. **Install the `ideate` command.** A small launcher at `<base>/marketplace/ideate` that runs
   `<base>/marketplace/plugins/ideate/bin/ideate.mjs` with its arguments (see "Which Claude account"
   below for the one other thing it does). `install()` links it at `/usr/local/bin/ideate` when
   that is writable. `setup.sh` handles `ideate` independently of `claudes`: if `ideate` on PATH
   doesn't resolve to this launcher after install, it links `~/bin/ideate` and adds the same PATH
   line it adds for `claudes`. That case is real on the owner's Mac, where `/usr/local/bin` is
   root-owned and `claudes` is already on PATH through an old link, so today's fallback would never
   run. If a different `ideate` is found earlier on PATH (for example an old `npm link`), setup says
   so and names it.
4. **Install the plugin into the shared layer.** If the `claude` CLI is present, run
   `claude plugin marketplace add <base>/marketplace` and `claude plugin install ideate@claude-pool`
   with `CLAUDE_CONFIG_DIR` set to a permanent host folder, `<base>/shared/.plugin-host/`, whose
   `plugins` and `settings.json` are links into `<base>/shared`, the same links `setup_shared_links`
   gives a real profile. This works before any account exists and never touches a profile's
   credentials. Each command has a timeout. The host folder is kept, not temporary: tested here, the
   install records its path through the config folder used (`<host>/plugins/cache/...`), so removing
   it would leave that path dangling. The same test showed the plugin listed and enabled from a
   second folder linked to the same shared layer.
5. **Re-running delivers the new version.** A second `./setup.sh` after pulling must leave every
   profile on the new plugin. The builder works out which commands that needs (for example
   uninstalling first, or a version bump with `claude plugin update`) and proves it in verification.
6. **Report.** One line each: whether `ideate` and `/ideate-review` were installed, and whether
   `agy` and `codex` were found on PATH, with a note that reviews need them installed and logged in.

When the base is the `claude_pool` clone itself, `<base>/marketplace/` is an untracked folder in the
repo; add `marketplace/` to `.gitignore`.

`ideate` joins `RESERVED` in `claudes.py` only if a `claudes ideate` subcommand is added; none is
planned.

Profiles that are not linked into the shared layer don't get the plugin. `claudes add` links new
profiles already, and `claudes migrate` links old ones; the report line says so when it finds an
unlinked profile.

### Which Claude account the tool uses

The tool calls `claude -p` for the writer. Inside a `claudes` session that inherits the session's
`CLAUDE_CONFIG_DIR`. From a plain terminal it would use the default `~/.claude`, which a teammate who
only uses pool profiles may never have logged in to.

So the launcher, when `CLAUDE_CONFIG_DIR` is not already set, sets it to the config folder of the
profile named in `<base>/current_profile` (looked up in `accounts.json`), and otherwise leaves the
environment alone (Claude's call). An idea started from the terminal therefore draws on the
most recently launched account's usage. If there is no current profile, nothing is set and the
default config is used, as today. The plugin's skill goes through the same launcher.

### The review command

Plugin skills are named `<plugin>:<skill>`, so the skill is renamed `review` and the command becomes
`/ideate:review` (Claude's call; the bare `/ideate-review` isn't available to a plugin). Asking in
plain words, such as "ideate review" or "review it first", works as before.

The same skill as today, with the machine-specific parts removed:

- It runs `ideate ...` from PATH, with no `cd` and no absolute repo path. If `ideate` isn't on PATH
  it tells the user to run the `claude_pool` setup.
- Reports point at `<home>/runs/<id>/report.md`; the skill gets the path from the CLI's own output
  and doesn't assume `~/.claudes`.
- The rest (pick the plan, `--proposal` with `--rounds 1`, judge findings against the code, revise
  only with the user's agreement) is unchanged.

### Docs

- `claude_pool` `README.md` and `SETUP.md`: a section on the bundled tool, what setup installs, the
  Node requirement, and that agy and Codex are separate.
- `claude_pool` `CLAUDE.md` and `AGENTS.md`: both currently say the repo has no build step, package
  manifest or tests. Update them: that remains true of the Python side; `ideate/` is a Node project
  with its own commands, and `plugins/ideate/` is generated output that must be rebuilt, not edited.
- `ideate/README.md`: install section replaced by "installed by the claude_pool setup", the new data
  location, and the development commands.

### Moving the owner's own setup (one-off, not shipped code)

On this Mac, after the new install works:

1. Stop the running `ideate ui` server.
2. Copy `<old ideation-loop clone>/config.json` and `runs/` to `~/.claudes/shared/ideate/`.
   Copy, not move.
3. Remove the `<profile A>` profile link added today and the `npm link`ed `ideate`, so the new install
   is the only one there. Re-point the `<profile C>` link (see "Profiles outside the shared layer").
4. Confirm the old ideas are listed by the new `ideate list` and in the app.

### Branching

`claude_pool` is on `add-claude-pool-tooling` with uncommitted edits to `claudes.py`. Its `main`
holds only `README.md`; `claudes.py` and `setup.sh` exist only on that unmerged branch. The work is
done in a separate git worktree on a new branch started from `add-claude-pool-tooling`, so the
owner's working tree is never touched. Nothing is pushed without the owner asking.

Before the import, in this repo: `feature/review-own-plan` is merged into `main` locally, and the
two design docs from today are committed so they move with the code. The owner's approval of this
design covers those two local steps.

### Profiles outside the shared layer

On the owner's Mac, `<profile A>` and `<profile B>` are linked into the shared layer; `<profile C>`, `<profile D>`
and `<profile E>` have their own `plugins` folder and `settings.json` and will not see the plugin.
`claudes migrate` links them, but replaces a profile's own `settings.json` with the shared one.
Whether to migrate them is the owner's decision and is not part of this build. Until then the
`<profile C>` profile keeps a hand-made skill link, re-pointed at
`<base>/marketplace/plugins/ideate/skills/review`.

## Verification

- `ideate/`: typecheck and the full test suite pass in the new location.
- New tests for data location: default home, `IDEATE_HOME`, `CLAUDES_BASE`, `--config`, first-run
  creation of the config, and a relative `runsDir` resolving beside the config from a different
  working folder.
- The bundle: `bundle:check` passes. From a folder with no `node_modules`, the bundled CLI runs a
  mock one-round review, and `ideate ui` serves the app and starts a worker.
- `claudes install` end to end with `CLAUDES_BASE` pointed at a temp folder, so the owner's real
  `~/.claudes` is untouched: the launcher exists, the plugin is recorded in the temp base's shared
  `plugins` and `settings.json`, and a profile added under that base lists the plugin.
- The same run with Node hidden from PATH, and with `claude` hidden from PATH: install finishes,
  prints the skip line, and `claudes` works.
- Re-run after changing the plugin: the new version is what the profile sees.
- `bash -n setup.sh`, and the existing import check from `CLAUDE.md` still shows standard library
  only.
- On the owner's Mac after migration: the review command appears in a new session under `<profile A>`
  (through the plugin) and `<profile C>` (through its link), old ideas are listed, and one real review
  runs through agy and Codex.

## Left to the builder

- Bundler configuration and how reproducibility is achieved.
- Exact wording of install messages and docs.
- The commands that make a re-run deliver a new plugin version.
- Whether the launcher is a shell script or a small Node file.
- The plugin's version scheme.
- Order of work, provided the tool keeps working from this repo until the new install is verified.

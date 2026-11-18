# ideate in claude_pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `ideate` tool into the `claude_pool` repo so that `./setup.sh` installs the `ideate` command and the `/ideate:review` plugin command for every `claudes` profile, with no separate installation.

**Architecture:** The tool's source moves to `claude_pool/ideate/` with history. A build script bundles the CLI into one file and the web app into static files under `claude_pool/plugins/ideate/`, which is committed and is a Claude Code plugin. `claudes install` copies that plugin source into the claudes base, writes an `ideate` wrapper, and installs the plugin once into the shared layer through a permanent host config folder. The tool finds its config and runs under `<claudes base>/shared/ideate/` and no longer depends on the working folder.

**Tech Stack:** TypeScript on Node 20+ (`node:test`, `tsx`, zod), Vite + React (existing), esbuild (new dev dependency), Python 3 standard library (`claudes.py`), bash (`setup.sh`), Claude Code plugin CLI (`claude plugin ...`).

**Spec:** `docs/superpowers/specs/2026-11-18-ideate-in-claude-pool-design.md` (in this repo until Task 1 moves it to `claude_pool/ideate/docs/superpowers/specs/`).

## Global Constraints

- Node 20 or newer. `claudes.py` stays standard library only; `requirements.txt` stays empty.
- Nothing committed may contain a machine-specific path (`/Users/...`).
- Never push. Never edit the `claude_pool` checkout at `<claude_pool clone>` (it has uncommitted work); all `claude_pool` work happens in the worktree created in Task 1. Never read or change `accounts.json` or anything under `profiles/`.
- Until Task 8, never run `setup.sh`, `claudes install` or `claude plugin ...` against the real `~/.claudes`. Every such run sets `CLAUDES_BASE` and `CLAUDES_BIN_DIR` to temp folders.
- `claudes` setup must never fail because of the tool: every ideate step that can't be done prints one line and install continues with exit code 0.
- Fixed names:
  - marketplace `claude-pool`, plugin `ideate`, skill `review` (command `/ideate:review`)
  - claudes base: `CLAUDES_BASE`, else `~/.claudes`
  - data home: `IDEATE_HOME`, else `<base>/shared/ideate`
  - plugin source copy: `<base>/marketplace/`; wrapper: `<base>/marketplace/ideate`
  - plugin host config folder: `<base>/shared/.plugin-host/`
- The tool must keep running three ways: from source under `tsx`, from `dist/`, and from the bundle.
- Commit after each task, in the worktree, with messages in the repo's style (`feat:`, `fix:`, `docs:`). End each commit message with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

Conditions the spec implies that no spec-listed test covers, each pinned by a test in the task named:

1. A data home whose path contains a space: config is created and a run lands there (Task 2).
2. `<home>/config.json` exists but is not valid JSON: the error names the file and the file is left as it was, not replaced by the example (Task 2).
3. An existing config with an absolute `runsDir`: used as is, not re-rooted under the home (Task 2).
4. `current_profile` names an account that isn't in `accounts.json`, or `accounts.json` is unreadable: `CLAUDE_CONFIG_DIR` is left unset and the tool runs (Task 3).
5. Re-running install over an existing `<base>/marketplace/` that holds a file no longer in the repo: the stale file is gone afterwards (Task 6).

---

### Task 0: Prepare this repo for the move

**Files:** none created. Repo: `<old ideation-loop clone>`.

- [ ] **Step 1:** On `feature/review-own-plan`, commit `docs/superpowers/specs/2026-11-18-model-settings-design.md`, `docs/superpowers/specs/2026-11-18-ideate-in-claude-pool-design.md` and `docs/superpowers/plans/2026-11-18-ideate-in-claude-pool.md` (`docs: designs for model settings and the move into claude_pool`).
- [ ] **Step 2:** `git checkout main && git merge --no-ff feature/review-own-plan`.
- [ ] **Step 3:** Run `npm run typecheck && npm test`. Expected: typecheck clean, `fail 0`.

### Task 1: Import the tool into a claude_pool worktree

**Files:**
- Create (by import): `ideate/**` in the worktree
- Worktree: `<worktree>`, branch `feature/ideate-plugin`

**Interfaces:**
- Produces: `$WT` = the worktree path; `$WT/ideate` is the tool's project root for all later tasks.

- [ ] **Step 1:** From `<claude_pool clone>`: `git worktree add -b feature/ideate-plugin ../claude_pool-ideate add-claude-pool-tooling`. This reads the branch tip only; the checkout's uncommitted `claudes.py` edits are not carried and must not be.
- [ ] **Step 2:** In `$WT`: `git subtree add --prefix=ideate <old ideation-loop clone> main`. Do not pass `--squash`.
- [ ] **Step 3:** In `$WT/ideate`: `npm ci && npm run typecheck && npm test`. Expected: same totals as Task 0 Step 3.
- [ ] **Step 4:** Confirm `git status` in `$WT` is clean (the subtree commit is the task's commit) and `git -C <claude_pool clone> status --short` still shows only ` M claudes.py`.

### Task 2: One data home, independent of the working folder

**Files:**
- Create: `ideate/src/home.ts`
- Modify: `ideate/src/config.ts` (`loadConfig`), `ideate/src/cli.ts` (default of `--config`, the "Config not found" check), `ideate/src/ui/server.ts:69` (drop the `resolve(cfg.runsDir)` that depended on cwd)
- Test: `ideate/test/home.test.ts`

**Interfaces:**
- Produces, from `src/home.ts`:
  - `claudesBase(env?: NodeJS.ProcessEnv): string` — `env.CLAUDES_BASE` if non-empty, else `join(homedir(), ".claudes")`.
  - `ideateHome(env?: NodeJS.ProcessEnv): string` — `env.IDEATE_HOME` if non-empty (a leading `~/` expanded), else `join(claudesBase(env), "shared", "ideate")`.
  - `resolveConfigPath(flag: string | undefined, env?: NodeJS.ProcessEnv): { path: string; created: boolean }` — `flag` resolved to absolute if given (must exist, else throw `Config not found: <path>`); otherwise `<home>/config.json`, created from `exampleConfigPath()` (with `mkdir -p` of the home) when missing.
  - `exampleConfigPath(): string` — `fileURLToPath(new URL("../config.example.json", import.meta.url))`. This one relative path is correct from `src/`, `dist/` and the bundle's `bin/`.
- Changes `loadConfig(path: string): Config` — the returned `runsDir` is always absolute: an absolute value is kept, a relative one is resolved against `dirname(resolve(path))`.

- [ ] **Step 1: Write the failing tests** in `test/home.test.ts`. Each uses a fresh temp folder and passes an explicit `env` object:
  - `ideateHome({ IDEATE_HOME: "/x/y" })` is `/x/y`; `ideateHome({ CLAUDES_BASE: "/b" })` is `/b/shared/ideate`; `ideateHome({})` ends with `/.claudes/shared/ideate`.
  - `resolveConfigPath(undefined, { IDEATE_HOME: <tmp>/"my home" })` returns `created: true`, the file exists and parses with `loadConfig`, and its `runsDir` equals `<tmp>/my home/runs` (Review Focus 1).
  - A second call returns `created: false` and leaves the file's bytes unchanged.
  - With `<home>/config.json` containing `{not json`: `loadConfig` of the resolved path throws an error whose message contains the file's path, and the file still contains `{not json` (Review Focus 2).
  - A config with `"runsDir": "/abs/elsewhere"` loads with `runsDir === "/abs/elsewhere"` (Review Focus 3).
  - `resolveConfigPath("nope.json", {})` throws `/Config not found/`.
  - CLI level, spawning `node --import tsx src/cli.ts` with `cwd` set to an unrelated temp folder that contains its own `config.json` with a different `primary`, and `IDEATE_HOME` set to a home holding a mock config: `run --proposal "x" --rounds 1 --id t1` exits 2 and `<home>/runs/t1/state.json` exists; nothing is created in the cwd.
- [ ] **Step 2:** Run `node --import tsx --test test/home.test.ts`. Expected: FAIL (module `../src/home.js` not found).
- [ ] **Step 3:** Implement `src/home.ts`, the `loadConfig` change, and in `cli.ts` replace the `config` option's `default: "config.json"` and the `existsSync` check with `resolveConfigPath(values.config)`; when `created` is true print one line to stderr: `Created <path> from the example config.` In `loadConfig`, wrap the JSON parse so a syntax error is rethrown as `Config <path> is not valid JSON: <reason>`. Update the USAGE text for `--config` to `(default: <data home>/config.json; data home is IDEATE_HOME or ~/.claudes/shared/ideate)`.
- [ ] **Step 4:** Run the whole suite: `npm run typecheck && npm test`. Expected: clean, `fail 0`. Existing tests pass `--config` or build `Config` objects with absolute temp `runsDir`, so they should need no change; fix any that relied on a cwd-relative `runsDir`.
- [ ] **Step 5:** Commit: `feat: ideate keeps config and runs in one data home`.

### Task 3: Use the pool's current account from a plain terminal

**Files:**
- Create: `ideate/src/account.ts`
- Modify: `ideate/src/cli.ts` (call at the top of `main()`)
- Test: `ideate/test/account.test.ts`

**Interfaces:**
- Consumes: `claudesBase(env)` from Task 2.
- Produces: `poolConfigDir(env?: NodeJS.ProcessEnv): string | undefined` — `undefined` when `env.CLAUDE_CONFIG_DIR` is already non-empty. Otherwise reads `<base>/current_profile` (trimmed name) and `<base>/accounts.json` (`{ accounts: [{ name, config_path? , path? }] }`), and returns that account's `config_path`, falling back to `path`, matching `config_dir()` in `claudes.py`. Any missing file, parse error, unknown name or missing path yields `undefined`; it never throws.
- `main()` does `const dir = poolConfigDir(); if (dir) process.env.CLAUDE_CONFIG_DIR = dir;` before anything spawns. Workers and provider CLIs inherit it.

This implements the spec's "launcher sets `CLAUDE_CONFIG_DIR`" inside the CLI itself, so it is covered by tests and behaves the same from source, `dist/` and the bundle.

- [ ] **Step 1: Write the failing tests**, each with a temp base passed as `CLAUDES_BASE`:
  - `current_profile` = `work\n`, accounts list has `work` with `config_path: "/p/work"` → `"/p/work"`.
  - Account has only `path` → that value.
  - `CLAUDE_CONFIG_DIR: "/already"` in env → `undefined`.
  - `current_profile` names `ghost`, not in the list → `undefined` (Review Focus 4).
  - `accounts.json` contains `not json` → `undefined`, no throw (Review Focus 4).
  - No `current_profile` file → `undefined`.
- [ ] **Step 2:** Run `node --import tsx --test test/account.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `src/account.ts` and the call in `main()`.
- [ ] **Step 4:** `npm run typecheck && npm test`. Expected: clean, `fail 0`.
- [ ] **Step 5:** Commit: `feat: ideate uses the pool's current account when none is set`.

### Task 4: The committed bundle

**Files:**
- Create: `ideate/scripts/bundle.mjs`
- Modify: `ideate/package.json` (scripts `bundle`, `bundle:check`; `test` runs `bundle:check` last; devDependency `esbuild`, exact version), `ideate/src/ui/server.ts:40` (`UI_DIR`), `ideate/src/ui/spawn.ts` (`defaultCliCommand`)
- Create (generated, committed): `plugins/ideate/bin/ideate.mjs`, `plugins/ideate/web/**`, `plugins/ideate/config.example.json`
- Test: `ideate/test/bundle.test.ts`, additions to the existing test file that covers `defaultCliCommand` (create `ideate/test/spawn.test.ts` if there is none)

**Interfaces:**
- `node scripts/bundle.mjs [--out <dir>] [--check]`:
  - default `--out` is `../plugins/ideate` relative to `ideate/`.
  - Writes `<out>/bin/ideate.mjs` (esbuild: entry `src/cli.ts`, `bundle`, `platform: "node"`, `format: "esm"`, `target: "node20"`, shebang kept, file mode 755; add a `createRequire` banner only if the bundle fails at runtime without one), `<out>/web/` (`vite build --config ui/vite.config.ts --outDir <out>/web --emptyOutDir`), and `<out>/config.example.json` (copy).
  - It removes `<out>/bin/ideate.mjs` and `<out>/web` before writing and touches nothing else under `<out>` (Task 5's files live there).
  - `--check` builds into a temp folder and compares those three paths with the committed ones, file by file; on any difference it lists the differing paths, prints `Run: npm run bundle`, and exits 1.
- `UI_DIR` becomes the first existing of, relative to the module: `../web/` (bundle `bin/`), `./web/` (`dist/`), `../../dist/web/` (source). If none exists keep today's behaviour for a missing build.
- `defaultCliCommand(moduleUrl = import.meta.url): string[]` gains one case, checked first: when the module file's basename is `ideate.mjs`, return `[process.execPath, <that file's path>]`. The `.ts` and `dist` cases are unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `defaultCliCommand("file:///a/b/bin/ideate.mjs")` deep-equals `[process.execPath, "/a/b/bin/ideate.mjs"]`; the existing `.ts` and `.js` expectations still hold.
  - `test/bundle.test.ts` runs `node scripts/bundle.mjs --out <tmp>/p`, then copies `<tmp>/p` to a second temp folder that has no `node_modules` anywhere above it, and from there, with `IDEATE_HOME` set to a temp home holding a mock config:
    - `node <copy>/bin/ideate.mjs run --proposal "plan" --rounds 1 --id b1` exits 2 and writes `<home>/runs/b1/round-1/review-a.json`.
    - starts `node <copy>/bin/ideate.mjs ui --port 0 --no-open`, reads the URL from stderr, and asserts `GET /` returns 200 with a body containing `<div id="root">`, and that `POST /api/ideas` with `{ "brief": "x", "rounds": 1 }` returns 201 and the idea reaches a final status (this proves the worker is started from the bundle). Kill the server in `after`.
    - With `IDEATE_HOME` pointing at an empty folder, `node <copy>/bin/ideate.mjs list` exits 0 and `<home>/config.json` now exists (the example was found beside the bundle).
  - Building twice into two temp folders produces byte-identical `bin/ideate.mjs` and identical `web/` file lists and contents.
- [ ] **Step 2:** Run `node --import tsx --test test/bundle.test.ts test/spawn.test.ts`. Expected: FAIL (`scripts/bundle.mjs` missing; the `ideate.mjs` case not handled).
- [ ] **Step 3:** Implement `scripts/bundle.mjs`, the two source changes, and the package scripts: `"bundle": "node scripts/bundle.mjs"`, `"bundle:check": "node scripts/bundle.mjs --check"`, and append `&& npm run bundle:check` to `test`.
- [ ] **Step 4:** Run `npm run bundle`, then `npm run typecheck && npm test`. Expected: clean, `fail 0`, and `bundle:check` prints no differences. `grep -c "/Users/" ../plugins/ideate/bin/ideate.mjs` must print `0`; if esbuild embedded absolute paths, fix the bundler options until it does.
- [ ] **Step 5:** Commit the script, source changes and generated `plugins/ideate/` files: `feat: bundle ideate into plugins/ideate`.

### Task 5: The plugin and its review skill

**Files:**
- Create: `.claude-plugin/marketplace.json`, `plugins/ideate/.claude-plugin/plugin.json`, `plugins/ideate/skills/review/SKILL.md`
- Delete: `ideate/.claude/skills/ideate-review/SKILL.md` (moved)
- Test: `ideate/test/plugin.test.ts`

**Interfaces:**
- `marketplace.json`: `{ "name": "claude-pool", "owner": { "name": "claude_pool" }, "plugins": [{ "name": "ideate", "source": "./plugins/ideate", "description": <one line> }] }`.
- `plugin.json`: `{ "name": "ideate", "version": <same as ideate/package.json>, "description": <one line> }`.
- `SKILL.md`: front matter `name: review`; the description keeps today's trigger phrases and adds `/ideate:review`. Body is today's skill with these changes only:
  - every command is `ideate ...` from PATH: no `cd`, no `/Users/...`, no `node dist/cli.js` fallback;
  - if `ideate` is not found, tell the user to run `./setup.sh` in their `claude_pool` clone and stop;
  - the report path is taken from the `Report: <path>` line the CLI prints at the end of a run;
  - the note about `config.json` says the reviewers are set in the data home's `config.json` (`ideate` prints its location when it creates it).

- [ ] **Step 1: Write the failing test** `test/plugin.test.ts`:
  - both JSON files parse; marketplace name is `claude-pool`; its single plugin is `ideate` with source `./plugins/ideate`; `plugin.json` `version` equals `package.json` `version`.
  - `SKILL.md` front matter has `name: review`; the file contains `--proposal` and `--rounds 1`; it does not contain `/Users/` or ` cd `.
  - If `claude` is on PATH (skip otherwise): with `CLAUDE_CONFIG_DIR` set to a temp folder, `claude plugin marketplace add <repo root>` and `claude plugin install ideate@claude-pool` both exit 0, and `claude plugin list` output contains `ideate@claude-pool`.
- [ ] **Step 2:** Run `node --import tsx --test test/plugin.test.ts`. Expected: FAIL (files missing).
- [ ] **Step 3:** Create the three files and delete the old skill file.
- [ ] **Step 4:** `npm test`. Expected: `fail 0`.
- [ ] **Step 5:** Commit: `feat: ideate plugin with the review skill`.

### Task 6: `claudes install` and `setup.sh` install the tool

**Files:**
- Modify: `claudes.py` (`install()` and new helpers directly above it), `setup.sh`, `.gitignore` (add `marketplace/`)
- Test: `ideate/test/claudes-install.test.ts`

**Interfaces:**
- New module constant: `BIN_DIR = Path(os.environ.get("CLAUDES_BIN_DIR", "/usr/local/bin"))`. `install()` uses it for the existing `claudes` link (replacing the hard-coded `/usr/local/bin/claudes`) and for the new `ideate` link. This exists so an install can be tested without touching the real links.
- `install_ideate(src_root: Path) -> None`, called at the end of `install()` with `Path(__file__).resolve().parent`, inside a `try/except Exception` that prints `ideate: skipped (<reason>)`. It never raises and never changes the exit code. Steps, in order:
  1. If `src_root / "plugins" / "ideate"` doesn't exist (for example when the installed copy `<base>/claudes` runs `install`), and `<base>/marketplace` doesn't exist either, print `ideate: not bundled with this copy; run setup.sh from the claude_pool clone` and return. If only the source is missing, keep the existing `<base>/marketplace` and continue.
  2. Otherwise replace `<base>/marketplace/` with a fresh copy of `src_root/.claude-plugin/marketplace.json` (kept at `.claude-plugin/marketplace.json`) and `src_root/plugins/`. Skip the copy when `src_root` is `BASE` itself. Remove the old folder first so stale files don't survive.
  3. Find `node` with `shutil.which`; run `node --version`; if missing or major < 20 print `ideate: needs Node 20 or newer (found <version or "none">); skipped` and return.
  4. Write `<base>/marketplace/ideate`, mode 755, exactly:
     ```sh
     #!/bin/sh
     export CLAUDES_BASE="${CLAUDES_BASE:-<absolute base>}"
     exec node "<absolute base>/marketplace/plugins/ideate/bin/ideate.mjs" "$@"
     ```
     Then try to link `BIN_DIR / "ideate"` to it (replace an existing link); on failure print nothing here, `setup.sh` handles the fallback.
  5. If `shutil.which("claude")` is None print `ideate: 'claude' CLI not found; the /ideate:review command was not installed` and go to step 7.
  6. Make `<base>/shared/.plugin-host/` with `plugins` and `settings.json` as symlinks to `<base>/shared/plugins` and `<base>/shared/settings.json`. With `CLAUDE_CONFIG_DIR` set to it and a 120 s timeout each, run the commands that leave `ideate@claude-pool` installed and current. Start from `claude plugin marketplace add <base>/marketplace` and `claude plugin install ideate@claude-pool`; add whatever a re-run needs (found in Step 3 below). A non-zero exit or timeout prints `ideate: plugin install failed (<last line of output>)`.
  7. Print the report lines: `ideate: command installed` (or not), `ideate: /ideate:review installed for linked profiles` (or not), one line each for `agy` and `codex` saying `found` or `not found (reviews need it installed and logged in)`, and, for every account whose config folder's `plugins` is not a symlink into `<base>/shared`, `ideate: profile '<name>' is not linked to the shared layer; run 'claudes migrate' for it to see the plugin`. Read account names and folders through the existing `load()` and `config_dir()` only.
- `setup.sh`: after the existing `claudes` PATH handling, an independent block for `ideate`. If `$BASE_DIR/marketplace/ideate` exists and `command -v ideate` doesn't resolve (via `readlink`/`-ef`) to it: when something else named `ideate` is on PATH print `Note: a different 'ideate' is earlier on PATH: <path>`; then `mkdir -p "$HOME/bin"`, `ln -sf "$BASE_DIR/marketplace/ideate" "$HOME/bin/ideate"`, and add the same `PATH_LINE` to the rc file if absent, setting `NEEDS_RELAUNCH=1`. Factor the rc-file selection so both blocks share it.

- [ ] **Step 1: Write the failing tests** in `ideate/test/claudes-install.test.ts`. A helper runs `python3 <repo root>/claudes.py install` with `CLAUDES_BASE=<tmp>/base`, `CLAUDES_BIN_DIR=<tmp>/bin`, `HOME=<tmp>/home`, and `PATH` set to a temp folder holding symlinks to only the tools that case allows (always `python3`, `sh`, `env`; plus `node` and `claude` as the case says). Skip the cases that need `claude` when it isn't installed. Cases:
  - **Full install:** exit 0; `<bin>/ideate` resolves to `<base>/marketplace/ideate`; running it with `list` exits 0 and creates `<base>/shared/ideate/config.json`; `<base>/shared/plugins/installed_plugins.json` has the key `ideate@claude-pool`; `<base>/shared/settings.json` has `enabledPlugins["ideate@claude-pool"] === true`; `<base>/shared/.plugin-host` still exists.
  - **A profile sees it:** make `<tmp>/prof` with the same two symlinks into `<base>/shared`; `CLAUDE_CONFIG_DIR=<tmp>/prof claude plugin list` contains `ideate@claude-pool` and `enabled`.
  - **Node hidden:** exit 0; output contains `needs Node 20`; `<base>/claudes` exists; no `<bin>/ideate`.
  - **claude hidden:** exit 0; output contains `'claude' CLI not found`; `<bin>/ideate` works.
  - **Stale file (Review Focus 5):** after a full install, create `<base>/marketplace/plugins/ideate/stale.txt`, run install again: exit 0 and the file is gone.
  - **Re-run delivers a change:** copy the repo's `.claude-plugin`, `plugins` and `claudes.py` to a temp source folder, install from it, then append a line containing `MARKER-2` to that copy's `skills/review/SKILL.md` and install again. Afterwards the `SKILL.md` under the path Claude Code reads the plugin from (take it from `claude plugin list`'s `Read from:` line for a linked profile, or from `installPath` in `installed_plugins.json`, whichever that install reports) contains `MARKER-2`.
  - **Installed copy re-runs install:** `python3 <base>/claudes install` with the same env exits 0 and leaves `<base>/marketplace` in place.
  - **Standard library only:** every top-level `import`/`from` in `claudes.py` names a module in `sys.stdlib_module_names` (run through `python3 -c`).
  - `bash -n setup.sh` exits 0.
- [ ] **Step 2:** Run `node --import tsx --test test/claudes-install.test.ts`. Expected: FAIL (no `<bin>/ideate`; no skip messages).
- [ ] **Step 3:** Implement `BIN_DIR`, `install_ideate` and the `setup.sh` block. While making the "Re-run delivers a change" case pass, try the candidates in this order and keep the first that works reliably: (a) the two commands as they are; (b) add `claude plugin marketplace update claude-pool`; (c) `claude plugin uninstall ideate@claude-pool` before install. Record in a comment above the commands which one was needed and why.
- [ ] **Step 4:** `npm test` in `ideate/`. Expected: `fail 0`. Then confirm isolation held: `ls -la /usr/local/bin/claudes` still points at `~/.claudes/claudes`, and `git -C <claude_pool clone> status --short` still shows only ` M claudes.py`.
- [ ] **Step 5:** Commit: `feat: claudes install sets up the ideate command and plugin`.

### Task 7: Docs

**Files:**
- Modify: `README.md`, `SETUP.md`, `CLAUDE.md`, `AGENTS.md` (repo root), `ideate/README.md`

- [ ] **Step 1:** `README.md` and `SETUP.md`: add a section "The ideate tool" covering what setup installs (the `ideate` command and `/ideate:review`), the Node 20 requirement and what happens without it, that agy and Codex are installed and logged in separately, where config and runs live, that profiles not linked to the shared layer need `claudes migrate`, and that updating is `git pull` plus `./setup.sh`. In `SETUP.md` add `CLAUDES_BIN_DIR` to the Config section and two Troubleshooting entries: a different `ideate` earlier on PATH, and the command missing in a profile.
- [ ] **Step 2:** `CLAUDE.md` and `AGENTS.md`: replace the claim that the repo has no build step, manifest or tests with: the Python side is unchanged (standard library, no build); `ideate/` is a Node project (`npm ci`, `npm run typecheck`, `npm test`, `npm run bundle`); `plugins/ideate/bin` and `plugins/ideate/web` are generated by `npm run bundle` and must never be edited by hand; `npm test` fails if they are out of date; install changes must be tested with `CLAUDES_BASE` and `CLAUDES_BIN_DIR` set to temp folders.
- [ ] **Step 3:** `ideate/README.md`: replace Setup with "installed by the claude_pool setup" plus the development commands; replace `npx tsx src/cli.ts`/`npm link` usage with `ideate ...`; document the data home, `IDEATE_HOME`, that a `config.json` in the working folder is no longer read, and which Claude account is used from a plain terminal; rename `/ideate-review` to `/ideate:review`.
- [ ] **Step 4:** `grep -rn "/Users/" README.md SETUP.md CLAUDE.md AGENTS.md ideate/README.md plugins/ideate/skills .claude-plugin` prints nothing. `npm test` in `ideate/`: `fail 0`.
- [ ] **Step 5:** Commit: `docs: ideate as part of claude_pool`.

### Task 8: Switch the owner's Mac over (with the owner, not unattended)

This task changes the owner's live setup. Stop and get the owner's go-ahead before Step 1, and do not run it from a subagent.

- [ ] **Step 1:** Stop the running `ideate ui` server (the background task from this session, or the process listening on port 4317).
- [ ] **Step 2:** From the worktree, run `./setup.sh`. Expected: the ideate report lines; `ideate` linked in `~/bin` (this Mac's `/usr/local/bin` is root-owned) with a note that `/opt/homebrew/bin/ideate` is earlier on PATH.
- [ ] **Step 3:** In `<old ideation-loop clone>`: `npm unlink -g ideation-loop` (removes `/opt/homebrew/bin/ideate`). `command -v ideate` now resolves to the new wrapper.
- [ ] **Step 4:** `mkdir -p ~/.claudes/shared/ideate && cp -n <old ideation-loop clone>/config.json ~/.claudes/shared/ideate/ && cp -Rn <old ideation-loop clone>/runs ~/.claudes/shared/ideate/`. Copy only; the originals stay.
- [ ] **Step 5:** Remove `~/.claudes/profiles/<profile A>/skills/ideate-review`. Replace `~/.claudes/profiles/<profile C>/skills/ideate-review` with a link named `ideate-review` to `~/.claudes/marketplace/plugins/ideate/skills/review` (that profile is not linked to the shared layer).
- [ ] **Step 6:** Verify: `ideate list` shows the earlier ideas; `ideate ui` serves them; a new Claude Code session under `<profile A>` lists `/ideate:review`, and one under `<profile C>` lists the linked skill; one real review of a short plan runs through agy and Codex and produces a report.
- [ ] **Step 7:** Report to the owner what remains theirs: pushing `feature/ideate-plugin`, merging it, what to do with `Suvaidyam/ideation-loop`, and whether to migrate the `<profile C>`, `<profile D>` and `<profile E>` profiles.

# claude_pool setup

`claude_pool` lets you juggle several Claude Code accounts on one machine. Each
account gets its own isolated config directory under `profiles/<name>/`, listed
in `accounts.json`. Running `claudes` with no arguments checks every account's
session/weekly usage live and shows an arrow-key menu to pick which one to
launch — it launches `claude` with `CLAUDE_CONFIG_DIR` pointed at the chosen
profile.

## Prerequisites

- macOS with `zsh` or `bash`
- `python3` (and `pip`) on PATH
- The `claude` CLI installed, and already logged in once per account you plan to add

## Setup

```bash
./setup.sh
```

This installs any packages listed in `requirements.txt` (none yet — the
tooling is stdlib-only today), then runs `claudes.py install` to create `~/.claudes` (profiles dir +
`accounts.json`) and put a `claudes` command on PATH. If `/usr/local/bin`
isn't writable (no sudo), the script automatically falls back to
`~/bin/claudes` and adds it to PATH in your shell rc file — then, if run
from a real terminal, relaunches your shell so `claudes` is ready to use
right away, no manual restart needed.

You can install manually instead, if you prefer:

```bash
python3 claudes.py install
```

## Verify

```bash
claudes list
```

## Adding an account

```bash
claudes add <name>
```

Account names use letters, digits, `-` and `_` only, start with a letter or digit, and are at most 64 characters, and are compared ignoring case (`Work` and `work` are the same name). This creates `profiles/<name>/` and then immediately runs `claude auth
login` under that profile — the login link gets copied to your clipboard
(see [Logging in](#logging-in) below) rather than opening a browser tab, so
you can paste it into whichever browser you want. Its credentials/session
land in that profile directory.

### Example

Adding an account named `alice` after `./setup.sh` has already been run:

```bash
$ claudes add alice
Added alice
Login link copied to clipboard — paste it into any browser to sign in:
https://claude.ai/... (your actual login URL)
# open that link in a browser, complete login

$ claudes list
alice

$ claudes alice
```

(`claudes alice` launches that account directly. `claudes` with no
arguments works too — with only one account it's the same thing, just
after a quick usage check.)

## Removing or renaming an account

```bash
claudes remove alice
claudes rename alice bob
```

`remove` deletes both the `accounts.json` entry and the account's profile
directory. It refuses if Claude is currently running under that account,
and otherwise asks for confirmation — pass `--force` to skip the prompt
(e.g. from a script). A config folder outside `profiles/`, or one shared with another account, is left on disk and only the entry is removed. If the current account is removed, the next bare
`claudes` re-checks everything from scratch.

`rename` applies the same naming rule to the new name (an existing account with an older name can still be renamed or removed). It only changes the name used to refer to the account; the profile
directory, credentials, and sessions are untouched. This means the old
name can't be reused via `claudes add` afterward — `add` will refuse
since the renamed account still owns that profile directory. Renaming
that account again does **not** free the directory (only its name
changes); `claudes remove` on it is the only way to actually free the
old name up for reuse.

Account names also can't be empty or collide with a built-in command
(`install`, `add`, `remove`, `rename`, `list`, `usage`, `migrate`) —
`add`/`rename` refuse those with an error, since `claudes <name>` would
never be able to tell the two apart (and an empty name would silently
point the account at the shared profile directory itself).

## Commands

| Command                  | Description                                              |
|---------------------------|-----------------------------------------------------------|
| `claudes remove <name>`    | Delete an account's entry and its profile directory (asks for confirmation unless `--force`) |
| `claudes rename <old> <new>` | Rename an account in place — no profile directory or credentials are touched |
| `claudes`                  | Check every account's session/usage live, then pick one to launch |
| `claudes <name>`           | Launch that account directly — skips the usage check entirely |
| `claudes list`             | List configured accounts                                  |
| `claudes usage`            | Show session/weekly usage % for every account with an active session |
| `claudes migrate [--dry-run]` | Link accounts (and the default `~/.claude` config) into the shared session layer, importing historical data; `--dry-run` only prints what it would do |

`usage` and bare `claudes` check every account for real by running
`claude -p /usage` under its config — all accounts are checked
concurrently (one thread per account), so the wait is bounded by the
slowest single account's check rather than the sum of all of them, then
every result prints at once, one line per account. Claude Code sessions
can expire and need a fresh login; a returncode-confirmed failure is
treated as an expired session (not 0% usage) rather than silently making a
logged-out account look like the best choice. A check that merely fails to
complete — timeout, network blip, missing config, or output the CLI
returned successfully but that doesn't parse — is reported separately as
"check failed" and excluded from the login-required menu entirely, so a
flaky check never triggers `claude auth login` on an account that might
still be perfectly valid. `claudes` then shows an arrow-key menu, e.g.:

```
Checking 2 accounts...
  ✓ alice        session  12%  week   5%  score   9.9
  ✗ carol        session expired

Recommended: alice — lowest score 9.9 among active sessions (70% session + 30% weekly usage)

Select an account (↑/↓ move, ←/→ switch, Enter choose, q cancel):

Available:                 Login required:
┌─────────────────────┐    ┌─────────────────────┐
│ alice  12%  5%  9.9  │    │ carol (Enter to log in) │  <- selected: bordered + highlighted
└─────────────────────┘    └─────────────────────┘
```

"Available" and "Login required" render side by side when both have
entries (otherwise whichever one exists renders alone, without the
←/→ hint). Use ↑/↓ to move within a column and ←/→ to switch columns; the
selected account is boxed and highlighted (the recommended one starts
pre-selected, so pressing Enter immediately accepts it), then `claudes`
launches `claude` with the chosen account. Accounts under "Login
required" are excluded from the usage comparison; choosing one logs you
in (see below) instead of launching a session, then everything is
re-checked and the menu reappears (now including that account, if login
succeeded). Press `q` to cancel without picking anything. When stdin
isn't a terminal (cron jobs, scripts, pipes), the menu is skipped and the
recommended account launches automatically.

Already know which account you want? `claudes <name>` skips all of the
above — no usage check, no menu — and launches `claude` under that
account's config immediately.

## Logging in

Whenever `claude auth login` needs to run — from `claudes add <name>` for a
brand-new account, or from picking a "Login required" entry in the
menu — `claudes` runs it directly and streams its output live. As soon as
the login URL appears, it's copied to your clipboard (via `pbcopy`) and
printed, instead of letting a browser tab open automatically:

```
Login link copied to clipboard — paste it into any browser to sign in:
https://claude.ai/oauth/authorize?...
```

Paste that link into whichever browser you want (useful if you're signed
into different Google/Okta/etc. accounts in different browsers) and
complete the login there; `claudes` keeps waiting and prints the result
once it's done. Browser auto-open is suppressed on a best-effort basis
only (`BROWSER=true` in the subprocess's environment) — if `claude` opens
one directly regardless, the copied link is still there as the reliable
fallback.

Changed your mind, or picked the wrong account? Press **Esc twice** while
it's waiting to cancel the login and go straight back to the account
menu — no need to wait it out or Ctrl-C the whole `claudes` process.

## Shared session context

Every profile normally has its own `projects/`, `plugins/`, `cache/`,
`history.jsonl`, and `settings.json` — meaning if you started a project
under `alice` and later switched to `bob`, `bob` wouldn't know that
project or session existed.

`claude_pool` avoids that by keeping one copy of those files in
`<CLAUDES_BASE>/shared/`, and replacing the per-profile copies with
symlinks into it. Every account reads and writes the same project
history, shell history, plugin state, cache, and settings — so switching
accounts to work around a usage limit doesn't cost you your context.
Launching an account via `claudes` also updates each project's "last
session" in the account's `.claude.json` first, so resuming a project
(`claude -c` / picking it from the project list) picks up the most recent
session regardless of which account you launched.

New accounts get wired into the shared layer automatically —
`claudes add <name>` calls this as part of creating the profile, so
there's usually nothing extra to do.

### Importing existing sessions

If you already had accounts set up before this feature existed (or ran
`claude` directly under `~/.claude` before adopting `claude_pool`), run:

```bash
claudes migrate
```

To see what it would do first, without changing anything on disk:

```bash
claudes migrate --dry-run
```

This will:

1. For every registered account, and for the default `~/.claude` config
   (used whenever you run plain `claude` without `CLAUDE_CONFIG_DIR` set)
   — skip it if a `claude` process is currently active under it and it
   still has something to merge (close that session, then re-run
   `claudes migrate`).
2. Otherwise, merge its own `projects/`, `plugins/` and `cache/` into
   `<CLAUDES_BASE>/shared/`, file by file and including subfolders
   (memory files, subagent logs, tool results, empty folders — everything,
   not just session `.jsonl` files):
   - a file shared doesn't have yet is copied in (through a temporary
     `.claudes-<random>.claudes-partial` file that is renamed into place
     only when complete, so shared never holds a half-copied file; such
     temp files left by a killed run are removed by a later run once they
     are ten minutes old);
   - a file shared already has with the same content is left alone;
   - a file shared already has with *different* content — or a file where
     the other side has a folder of the same name — is a **conflict**:
     shared's copy is kept as it is, and the path is listed in the output;
   - a `memory/MEMORY.md` index present in both is merged: lines from the
     profile's copy that shared's lacks are appended, except a line whose
     link already points at a file shared's index lists (an index that
     isn't valid UTF-8, or that has nothing to add, is reported as a
     plain conflict);
   - a symlink inside the folder is copied as a symlink, unless it would
     point at nothing from its new place in shared; it is then listed as
     "link kept only in the backup";
   - a socket, FIFO or other special file is not copied; it is listed as
     "not copied (special file); kept only in the backup".

   `history.jsonl` entries are appended to shared's history, skipping
   duplicates; lines that aren't valid JSON are carried across unchanged.

   `settings.json` is copied into shared only if shared's is still empty
   (`{}`). Otherwise shared's settings win and nothing is merged
   automatically (merged rules would apply to every account): if the
   profile's file differs, it is reported as a conflict — that profile's
   own settings (hooks, permission rules, ...) are **no longer in effect**
   — with the names of the top-level keys that differ or exist only in the
   profile's file, and where its file was kept. Copy anything you still
   want into the shared `settings.json` by hand.

   If `projects/`, `plugins/`, `cache/`, `history.jsonl` or `settings.json`
   is a symlink pointing somewhere other than the shared layer, the link
   itself is kept (renamed as below, and the output says where it
   pointed), and the content it points at is merged by the same rules;
   that content is never moved or changed. If the link points at the
   shared layer itself, at a folder that contains it (such as
   `<CLAUDES_BASE>`), or at something inside it, its target is not merged
   at all — the output says so — and only the link is kept.
3. Once an item's content is verified to be in the shared layer, the
   profile's original is **kept**, renamed to
   `<name>.pre-claudes-<timestamp>` next to it (for example
   `projects.pre-claudes-20260101-093000`), and replaced with a symlink
   into the shared layer. If anything can't be copied (an unreadable
   file, a full disk), that item is not renamed or linked and the error is
   printed; the other items are still linked. The profile's own folder or
   file is untouched, but files that were copied completely before the
   error stay in shared (they are copies, so nothing is lost), and the
   next run picks up where this one stopped. From then on plain `claude`
   reads and writes the same shared context as every pool account.

   It refuses to run on the shared layer itself (a profile path that is,
   contains or lies inside `<CLAUDES_BASE>/shared/`), and skips an item
   whose profile copy and shared copy are the same folder or file.
4. Separately, copy in (without deleting) any leftover historical
   session/history data sitting in stale locations from earlier setups —
   old per-account directories directly under `~/.claudes/`, and orphaned
   `~/.claude/<name>` / `~/.claude/profiles/<name>` directories.

For each profile it prints how many files were copied, merged and
conflicting, every conflicting path, and where the original was kept;
then how many session files and history entries were imported from each
stale source.

Nothing is ever deleted. Once you are satisfied that everything you need
is in the shared layer — check any conflicts it listed against the
`*.pre-claudes-*` copy — you can delete the `*.pre-claudes-*` folders and
files yourself. Re-running is safe: profiles that are already linked are
left as they are, and already-imported data is skipped rather than
duplicated.

**Note:** this changes `~/.claude`'s directory structure — `projects/`,
`plugins/`, `cache/`, `history.jsonl`, and `settings.json` become symlinks
into `<CLAUDES_BASE>/shared/`. Nothing else under `~/.claude` (credentials,
etc.) is touched.

## The ideate tool

`./setup.sh` (through `claudes.py install`) also sets up `ideate`, which sends
a plan to other models for an adversarial review. It installs:

- the `ideate` command. Setup copies the plugin files to `<base>/marketplace/`
  (a fresh copy each run) and writes a wrapper at `<base>/marketplace/ideate`.
  The wrapper sets `CLAUDES_BASE` if it isn't set and runs the bundled tool
  with `node`. It is linked into `/usr/local/bin`, or into `~/bin` by
  `setup.sh` when that isn't writable.
- the `/ideate:review` command, from a plugin named `ideate` in a local
  marketplace named `claude-pool`. It is installed once, into the shared
  layer, so every profile linked to it gets it. Asking in plain words, such
  as "review it first", also works.

If `claude` is not on PATH, the command is installed but the plugin is not;
install Claude Code and re-run `./setup.sh`.

When the base is this repo clone itself, setup creates an untracked
`marketplace/` folder in it. It is gitignored.

**Node.** Node 20 or newer is required. If the `node` on PATH during setup is
older or missing, setup prints `ideate: needs Node 20 or newer (found ...);
skipped`. The `/ideate:review` plugin is not installed and the installer does
not link the command, but the wrapper is still written to
`<base>/marketplace/ideate` and `setup.sh` may still link it into `~/bin`.
The rest of setup finishes as usual. The wrapper works once Node 20 or newer
is first on PATH; re-run `./setup.sh` then to install the plugin.

The `ideate` command runs whichever `node` is first on PATH when you use it,
not the one checked during setup. The wrapper checks that `node` first: with
no working `node` it prints `ideate: needs Node 20 or newer; no working 'node'
on PATH` and exits 127; with an older one it prints `ideate: needs Node 20 or
newer (found <version> at <path>)` and exits 1.

**Other CLIs.** agy and Codex are separate CLIs from other vendors. Setup only
prints whether each is found. Install them and log in to each yourself;
reviews need them.

**Where things live.** The data home is `IDEATE_HOME`, else
`<base>/shared/ideate/` (`~/.claudes/shared/ideate/` by default). It holds
`config.json` (created from the example the first time the tool needs it) and
`runs/`. A `config.json` in the folder you run from is not read; pass
`--config <path>` to use another file.

**Profiles.** The plugin is installed through a config folder at
`<base>/shared/.plugin-host/`, which holds links to the shared `plugins/` and
`settings.json`. Every profile reaches the plugin's files through it, so never
delete it. A profile whose `plugins/` is not linked to the shared layer does
not see the plugin; setup prints a line for each such profile, and `claudes
migrate` links it.

**Updating.** `git pull`, then `./setup.sh` again. Re-running setup uninstalls
and reinstalls the plugin so every profile gets the new version. A plugin you
had disabled stays disabled. If `ideate ui` is running, restart it afterwards:
it keeps serving the version it started with.

Every ideate step that can't be done prints one line and setup carries on;
ideate never makes setup fail.

## Config

By default the pool lives at `~/.claudes`. Override with `CLAUDES_BASE` to
point it elsewhere (e.g. this repo's own `profiles/` directory):

```bash
export CLAUDES_BASE=<path to this repo clone>
```

`CLAUDES_BIN_DIR` sets the folder that gets the `claudes` and `ideate` links
(default `/usr/local/bin`). It is mainly for testing the installer: run it
with `CLAUDES_BASE` and `CLAUDES_BIN_DIR` both pointing at temp folders.

`CLAUDES_PLUGIN_TIMEOUT` sets how many seconds each `claude plugin ...` call
may take during setup (default 120). A call that takes longer is stopped,
together with anything it started, and setup carries on without the plugin.

`IDEATE_HOME` moves the ideate data home; see [The ideate tool](#the-ideate-tool).

## Troubleshooting

**`claudes: command not found`** — `/usr/local/bin` usually requires sudo to
write to. Re-run `./setup.sh`; it detects this and falls back to
`~/bin/claudes` plus a PATH entry in your shell rc file automatically. When
run from a real terminal, it then relaunches your shell (`exec "$SHELL"
-li`) so `claudes` is ready to use immediately — no restart needed. If
`setup.sh` was run non-interactively (piped stdin, CI, etc.), it instead
prints `Restart your terminal (or run: source <rc file>)`; do that manually
in that case.

**`ideate` runs the wrong tool, or an old one** — another `ideate` is earlier
on PATH. Check with `command -v ideate`. When setup finds this it prints
`Note: a different 'ideate' is earlier on PATH: <path>` and links its own into
`~/bin`, which may still come later. Remove the other one, or put `~/bin` (or
the folder `claudes` is in) first on PATH. A `~/bin/ideate` that is a file
rather than a link is left alone (`ideate: ~/bin/ideate exists and is not a
link; left as it is`).

**`/ideate:review` is missing in a profile** — check the setup output. Usual
causes: the profile is not linked to the shared layer (run
`claudes migrate`); `claude` was not on PATH during setup, or the plugin
install failed (setup printed `ideate: plugin install failed ...`; re-run
`./setup.sh`); or the plugin is disabled in the shared settings. Do not delete
`<base>/shared/.plugin-host/`: every profile reaches the plugin's files through
it. If you did, re-run `./setup.sh` to recreate it.

**`ideate: command not found` or Node errors** — if `ideate` prints
`ideate: needs Node 20 or newer; no working 'node' on PATH` or
`ideate: needs Node 20 or newer (found <version> at <path>)`, put Node 20 or
newer first on PATH (see **Node** above); check with `node --version`. If
setup printed `ideate: needs Node 20 or newer (found ...); skipped`, the
command may exist (linked by `setup.sh`) but fail until Node is fixed, and the
plugin is not installed yet: fix Node and re-run `./setup.sh`.

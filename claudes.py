#!/usr/bin/env python3
import json, os, pty, re, select, shutil, signal, stat, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HOME = Path.home()
BASE = Path(os.environ.get("CLAUDES_BASE", HOME / ".claudes")).expanduser()
PROFILES = BASE / "profiles"
ACCOUNTS = BASE / "accounts.json"
CURRENT = BASE / "current_profile"
SHARED = BASE / "shared"
BIN_DIR = Path(os.environ.get("CLAUDES_BIN_DIR", "/usr/local/bin"))

GREEN="\033[92m"; YELLOW="\033[93m"; RED="\033[91m"; GRAY="\033[90m"; RESET="\033[0m"

RESERVED = {"install","add","remove","rename","list","usage","migrate"}

def ensure():
    BASE.mkdir(exist_ok=True)
    PROFILES.mkdir(exist_ok=True)
    SHARED.mkdir(exist_ok=True)
    for d in ["projects", "plugins", "cache"]:
        (SHARED / d).mkdir(exist_ok=True)
    if not (SHARED / "history.jsonl").exists():
        (SHARED / "history.jsonl").touch()
    if not (SHARED / "settings.json").exists():
        (SHARED / "settings.json").write_text("{}")
    if not ACCOUNTS.exists():
        ACCOUNTS.write_text('{"accounts": []}')

def load():
    ensure()
    return json.loads(ACCOUNTS.read_text())

def save(data):
    ACCOUNTS.write_text(json.dumps(data, indent=2))

def find(name):
    d=load()
    for a in d["accounts"]:
        if a["name"]==name:
            return a
    return None

def config_dir(account):
    path = account.get("config_path") or account.get("path")
    if not path:
        raise KeyError(f"Account {account.get('name', '<unknown>')} has no config_path")
    return path

def _encode_path(abs_path):
    return re.sub(r'[^a-zA-Z0-9]', '-', abs_path)

def _has_active_sessions(profile_path):
    """Return True if any live Claude process is using this profile."""
    sessions_dir = Path(profile_path) / "sessions"
    if not sessions_dir.is_dir():
        return False
    for f in sessions_dir.iterdir():
        if f.suffix == ".json":
            try:
                pid = int(f.stem)
                os.kill(pid, 0)
                return True
            except (ValueError, OSError):
                pass
    return False

def _merge_projects(src_dir, dst_dir, dry_run=False):
    """Copy session .jsonl files from src into dst where dst has none yet.

    Never moves or deletes anything in src. Returns the number copied (or, with
    dry_run, the number that would be copied, writing nothing)."""
    src = Path(src_dir)
    dst = Path(dst_dir)
    if not src.is_dir():
        return 0
    count = 0
    for encoded in src.iterdir():
        if not encoded.is_dir():
            continue
        dst_encoded = dst / encoded.name
        for f in encoded.iterdir():
            if f.suffix == ".jsonl":
                dst_f = dst_encoded / f.name
                if not dst_f.exists():
                    if dry_run:
                        count += 1
                        continue
                    try:
                        dst_encoded.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(str(f), str(dst_f))
                        count += 1
                    except OSError as e:
                        print(f"    {YELLOW}Could not copy {f}: {e}{RESET}")
    return count

def _merge_history(src_file, dst_file, dry_run=False):
    """Append non-duplicate entries from src to dst. Returns count of new lines."""
    src = Path(src_file)
    dst = Path(dst_file)
    try:
        if not src.is_file() or src.stat().st_size == 0:
            return 0
    except OSError:
        return 0
    seen = set()
    if dst.is_file() and dst.stat().st_size > 0:
        for line in dst.read_text().splitlines():
            try:
                e = json.loads(line)
                seen.add((e.get("sessionId",""), str(e.get("timestamp",""))))
            except Exception:
                pass
    try:
        src_lines = src.read_text().splitlines()
    except OSError:
        return 0
    new_lines = []
    for line in src_lines:
        if not line.strip():
            continue
        try:
            e = json.loads(line)
            key = (e.get("sessionId",""), str(e.get("timestamp","")))
            if key not in seen:
                new_lines.append(line)
                seen.add(key)
        except Exception:
            pass
    if new_lines and not dry_run:
        with open(dst, "a") as f:
            f.write("\n".join(new_lines) + "\n")
    return len(new_lines)

SHARED_DIRS = ["projects", "plugins", "cache"]
SHARED_FILES = ["history.jsonl", "settings.json"]

def _timestamp():
    return time.strftime("%Y%m%d-%H%M%S")

def _backup_path(item, stamp):
    """`<name>.pre-claudes-<stamp>` next to item, with -2, -3, ... if taken."""
    cand = item.with_name(f"{item.name}.pre-claudes-{stamp}")
    n = 2
    while cand.exists() or cand.is_symlink():
        cand = item.with_name(f"{item.name}.pre-claudes-{stamp}-{n}")
        n += 1
    return cand

def _same_bytes(a, b):
    with open(a, "rb") as fa, open(b, "rb") as fb:
        while True:
            x = fa.read(1 << 16); y = fb.read(1 << 16)
            if x != y:
                return False
            if not x:
                return True

_LINK_TARGET = re.compile(r"\]\(([^)]*)\)")

def _merge_memory_index(src, dst, dry_run=False):
    """Append to dst each non-blank line of src it lacks, skipping a line whose
    markdown link targets are all already in dst. Returns lines appended."""
    dst_text = dst.read_text()
    have = set(dst_text.splitlines())
    add = []
    for line in src.read_text().splitlines():
        if not line.strip() or line in have:
            continue
        targets = _LINK_TARGET.findall(line)
        if targets and all(f"]({t})" in dst_text for t in targets):
            continue
        add.append(line)
        have.add(line)
    if add and not dry_run:
        with open(dst, "a") as f:
            if dst_text and not dst_text.endswith("\n"):
                f.write("\n")
            f.write("\n".join(add) + "\n")
    return len(add)

def _merge_tree(src, dst, dry_run=False):
    """Merge every file under src into dst without touching anything in src.

    Absent files are copied (symlinks as symlinks); identical files are left;
    differing files are conflicts (dst untouched), except a memory/MEMORY.md
    index, whose missing lines are appended. Then verifies every src file is
    accounted for in dst. Returns (copied, merged, conflicts, errors)."""
    copied = merged = 0
    conflicts, errors = [], []
    handled = {}   # rel -> "copied" | "same" | "merged" | "conflict"

    def walk_error(e):
        errors.append(f"cannot read {e.filename}: {e.strerror}")

    for dirpath, dirnames, filenames in os.walk(src, onerror=walk_error):
        d = Path(dirpath)
        entries = filenames + [n for n in dirnames if (d / n).is_symlink()]
        for n in entries:
            s = d / n
            rel = str(s.relative_to(src))
            t = dst / rel
            try:
                if s.is_symlink():
                    link = os.readlink(s)
                    if t.is_symlink() and os.readlink(t) == link:
                        handled[rel] = "same"
                    elif os.path.lexists(t):
                        handled[rel] = "conflict"
                    else:
                        if not dry_run:
                            t.parent.mkdir(parents=True, exist_ok=True)
                            os.symlink(link, t)
                        handled[rel] = "copied"
                elif not os.path.lexists(t):
                    if dry_run:
                        with open(s, "rb"):
                            pass   # surface unreadable files in a dry run too
                    else:
                        t.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(s, t)
                    handled[rel] = "copied"
                elif t.is_file() and not t.is_symlink() and _same_bytes(s, t):
                    handled[rel] = "same"
                elif n == "MEMORY.md" and d.name == "memory" and t.is_file() and not t.is_symlink():
                    _merge_memory_index(s, t, dry_run)
                    handled[rel] = "merged"
                else:
                    handled[rel] = "conflict"
            except OSError as e:
                errors.append(f"{rel}: {e.strerror or e}")
        dirnames[:] = [n for n in dirnames if not (d / n).is_symlink()]

    for rel, how in sorted(handled.items()):
        if how == "copied":
            copied += 1
        elif how == "merged":
            merged += 1
        elif how == "conflict":
            conflicts.append(rel)

    if not dry_run and not errors:
        # Verify: every file in src is now present in dst.
        for dirpath, dirnames, filenames in os.walk(src, onerror=walk_error):
            d = Path(dirpath)
            for n in filenames + [n for n in dirnames if (d / n).is_symlink()]:
                s = d / n
                rel = str(s.relative_to(src))
                t = dst / rel
                how = handled.get(rel)
                try:
                    if how is None or not os.path.lexists(t):
                        ok = False
                    elif how in ("merged", "conflict"):
                        ok = True
                    elif s.is_symlink():
                        ok = t.is_symlink() and os.readlink(t) == os.readlink(s)
                    else:
                        ok = t.is_file() and _same_bytes(s, t)
                except OSError:
                    ok = False
                if not ok:
                    errors.append(f"{rel}: not found in the shared copy after merging")
            dirnames[:] = [n for n in dirnames if not (d / n).is_symlink()]
    return copied, merged, conflicts, errors

def _new_result():
    return {"copied": 0, "merged": 0, "conflicts": [], "backup": None,
            "linked": False, "error": None, "action": "none"}

def setup_shared_links(profile_path, dry_run=False):
    """Point a profile's portable dirs/files at SHARED, merging first.

    Never deletes anything: a profile's own folder or file is merged into the
    shared layer, verified, then kept as `<name>.pre-claudes-<timestamp>`
    before the symlink is made. Returns {item: result dict}."""
    p = Path(profile_path)
    names = SHARED_DIRS + SHARED_FILES
    results = {n: _new_result() for n in names}
    tag = f"{YELLOW}[dry run]{RESET} " if dry_run else ""

    def is_ours(item, target):
        return item.is_symlink() and item.resolve() == target.resolve()

    needs_merge = [n for n in names
                   if not (p / n).is_symlink() and (p / n).exists()]
    if needs_merge and _has_active_sessions(p):
        print(f"Skipping {p} — Claude is running under it; close it and try again")
        for r in results.values():
            r["error"] = "skipped: Claude is running under this profile"
        return results

    if not dry_run:
        ensure()
    stamp = _timestamp()
    print(f"{tag}Linking {p} to the shared layer")

    for name in names:
        item = p / name
        target = SHARED / name
        r = results[name]
        if is_ours(item, target):
            r["linked"] = True
            r["action"] = "already linked"
            continue
        if item.is_symlink():
            r["action"] = "replace link"
            if not dry_run:
                item.unlink()
        elif item.is_dir() and name in SHARED_DIRS:
            r["action"] = "merge"
            copied, merged, conflicts, errors = _merge_tree(item, target, dry_run)
            r.update(copied=copied, merged=merged, conflicts=conflicts)
            if errors:
                r["error"] = "; ".join(errors)
                print(f"  {RED}{name}: not linked — {r['error']}{RESET}")
                print(f"    {item} was left where it is; fix the problem and run this again.")
                continue
        elif item.is_file() and name in SHARED_FILES:
            r["action"] = "merge"
            if not dry_run:
                try:
                    if name == "history.jsonl":
                        r["merged"] = _merge_history(item, target)
                    else:
                        cur = target.read_text().strip() if target.is_file() else ""
                        if cur in ("{}", ""):
                            shutil.copy2(item, target)
                            r["copied"] = 1
                except OSError as e:
                    r["error"] = f"{e.strerror or e}"
                    print(f"  {RED}{name}: not linked — {r['error']}{RESET}")
                    continue
            elif name == "history.jsonl":
                r["merged"] = _merge_history(item, target, dry_run=True)
            else:
                cur = target.read_text().strip() if target.is_file() else ""
                r["copied"] = 1 if cur in ("{}", "") else 0
        elif os.path.lexists(item):
            r["action"] = "left alone"
            r["error"] = f"{item} is neither a symlink nor a {'folder' if name in SHARED_DIRS else 'file'}; left alone"
            print(f"  {RED}{name}: {r['error']}{RESET}")
            continue
        else:
            r["action"] = "link"

        if r["action"] == "merge":
            backup = _backup_path(item, stamp)
            r["backup"] = str(backup)
            if not dry_run:
                try:
                    item.rename(backup)
                except OSError as e:
                    r["backup"] = None
                    r["error"] = f"could not rename to {backup}: {e.strerror or e}"
                    print(f"  {RED}{name}: not linked — {r['error']}{RESET}")
                    continue
        if not dry_run:
            try:
                item.symlink_to(target)
            except OSError as e:
                r["error"] = f"could not create the link: {e.strerror or e}"
                print(f"  {RED}{name}: {r['error']}{RESET}")
                continue
        r["linked"] = True

        verb = "would " if dry_run else ""
        if r["action"] == "merge":
            parts = []
            if name in SHARED_DIRS:
                parts.append(f"{r['copied']} copied, {r['merged']} merged, {len(r['conflicts'])} conflicting")
            elif name == "history.jsonl":
                parts.append(f"{r['merged']} entries added")
            else:
                parts.append("copied to shared" if r["copied"] else "shared copy kept")
            print(f"  {name}: {', '.join(parts)}; original {verb}{'be ' if dry_run else ''}kept at {r['backup']}")
            for c in r["conflicts"]:
                print(f"    {YELLOW}conflict{RESET} {c} — shared copy kept; yours is in the backup")
        elif r["action"] in ("link", "replace link"):
            print(f"  {name}: {verb}{'link' if dry_run else 'linked'}")
    return results

def _sync_last_session(name):
    """Update lastSessionId per-project in the account's .claude.json."""
    a = find(name)
    if not a:
        return
    cj = Path(config_dir(a)) / ".claude.json"
    if not cj.exists():
        return
    projects_shared = SHARED / "projects"
    if not projects_shared.is_dir():
        return
    try:
        data = json.loads(cj.read_text())
    except Exception:
        return
    projects_map = data.get("projects", {})
    if not projects_map:
        return
    changed = False
    for abs_path, proj in list(projects_map.items()):
        encoded_dir = projects_shared / _encode_path(abs_path)
        if not encoded_dir.is_dir():
            continue
        jsonl_files = [f for f in encoded_dir.iterdir() if f.suffix == ".jsonl"]
        if not jsonl_files:
            continue
        latest = max(jsonl_files, key=lambda f: f.stat().st_mtime)
        uuid = latest.stem
        if proj.get("lastSessionId") != uuid:
            proj["lastSessionId"] = uuid
            changed = True
    if changed:
        cj.write_text(json.dumps(data, indent=2))

IDEATE_PLUGIN = "ideate@claude-pool"

def _plugin_timeout():
    try:
        return float(os.environ.get("CLAUDES_PLUGIN_TIMEOUT", "120"))
    except ValueError:
        return 120.0

# Seconds each `claude plugin ...` call may take during install.
PLUGIN_TIMEOUT = _plugin_timeout()

def _run_bounded(cmd, timeout, env=None):
    """Run cmd with stdin from /dev/null; (returncode, stdout, stderr).
    The child gets its own session and its output goes to temp files, so on
    timeout its whole process group is killed and nothing is left to wait on
    (a grandchild holding a pipe would make subprocess.run wait forever).
    The group is also killed when the wait is interrupted (Ctrl-C). Raises
    subprocess.TimeoutExpired, or the interruption, after that."""
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                             start_new_session=True)
        try:
            p.wait(timeout=timeout)
        except BaseException:
            # A timeout, or Ctrl-C (which no longer reaches the child's session).
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            raise
        out.seek(0)
        err.seek(0)
        return (p.returncode, out.read().decode(errors="replace"),
                err.read().decode(errors="replace"))

def _copy_marketplace(src_root, market):
    """Replace `market` with a fresh copy of the marketplace file and plugins/,
    built beside it first so a failed copy leaves the old one in place."""
    staging = market.with_name(market.name + ".new")
    if staging.exists():
        shutil.rmtree(staging)
    (staging / ".claude-plugin").mkdir(parents=True)
    shutil.copy2(src_root / ".claude-plugin" / "marketplace.json", staging / ".claude-plugin" / "marketplace.json")
    shutil.copytree(src_root / "plugins", staging / "plugins")
    if market.exists() or market.is_symlink():
        if market.is_dir() and not market.is_symlink():
            shutil.rmtree(market)
        else:
            market.unlink()
    staging.rename(market)

def _node_version():
    """(major, text) for the `node` on PATH; (None, "none") when there is none."""
    node = shutil.which("node")
    if not node:
        return None, "none"
    try:
        text = _run_bounded([node, "--version"], 30)[1].strip() or "unknown"
    except Exception:
        return None, "unknown"
    m = re.match(r"v?(\d+)\.", text)
    return (int(m.group(1)) if m else None), text

def _sh_quote(s):
    """Escape a string for use inside double quotes in sh."""
    return re.sub(r'([\\"$`])', r"\\\1", s)

def _write_ideate_wrapper(market):
    base = _sh_quote(str(BASE.resolve()))
    wrapper = market / "ideate"
    # The Node check uses only sh built-ins: PATH may hold nothing but node.
    wrapper.write_text(
        "#!/bin/sh\n"
        f'export CLAUDES_BASE="${{CLAUDES_BASE:-{base}}}"\n'
        'v=$(node --version 2>/dev/null) || v=""\n'
        'm=${v#v}; m=${m%%.*}\n'
        "case \"$m\" in ''|*[!0-9]*) echo \"ideate: needs Node 20 or newer; no working 'node' on PATH\" >&2; exit 127;; esac\n"
        '[ "$m" -ge 20 ] || { echo "ideate: needs Node 20 or newer (found $v at $(command -v node))" >&2; exit 1; }\n'
        f'exec node "{base}/marketplace/plugins/ideate/bin/ideate.mjs" "$@"\n'
    )
    wrapper.chmod(0o755)
    return wrapper

def _link_ideate(wrapper):
    """Point BIN_DIR/ideate at the wrapper. Replaces a symlink, never a real
    file. True when the link is in place; setup.sh handles the fallback."""
    link = BIN_DIR / "ideate"
    try:
        if link.is_symlink():
            link.unlink()
        elif link.exists():
            return False
        link.symlink_to(wrapper)
        return True
    except OSError:
        return False

def _link_into(folder, name, target):
    item = folder / name
    if item.is_symlink() and item.resolve() == target.resolve():
        return
    if item.is_dir() and not item.is_symlink():
        shutil.rmtree(item)
    elif item.exists() or item.is_symlink():
        item.unlink()
    item.symlink_to(target)

def _ideate_plugin_installed():
    """True when the shared plugins list ideate@claude-pool at user scope."""
    try:
        data = json.loads((SHARED / "plugins" / "installed_plugins.json").read_text())
        entries = data.get("plugins", {}).get(IDEATE_PLUGIN) or []
        return any(e.get("scope") == "user" for e in entries)
    except Exception:
        return False

def _ideate_disabled():
    """True when the shared settings have ideate@claude-pool explicitly disabled."""
    try:
        data = json.loads((SHARED / "settings.json").read_text())
        return data.get("enabledPlugins", {}).get(IDEATE_PLUGIN) is False
    except Exception:
        return False

def _disable_ideate():
    """Set enabledPlugins[ideate@claude-pool] back to false, keeping every
    other key; leaves a settings file it can't parse alone. Writes a temp file
    beside the real file (through any symlink) and renames it into place."""
    path = (SHARED / "settings.json").resolve()
    try:
        data = json.loads(path.read_text())
    except Exception:
        return
    if not isinstance(data, dict):
        return
    enabled = data.get("enabledPlugins")
    if not isinstance(enabled, dict):
        enabled = data["enabledPlugins"] = {}
    enabled[IDEATE_PLUGIN] = False
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".settings.json.")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(data, indent=2) + "\n")
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

def _run_claude(claude, args, env):
    """Run one `claude` command; (error line or None when it succeeded, its output)."""
    try:
        code, stdout, stderr = _run_bounded([claude] + args, PLUGIN_TIMEOUT, env)
    except subprocess.TimeoutExpired:
        return f"'claude {' '.join(args)}' timed out", ""
    except OSError as e:
        return f"'claude {' '.join(args)}' could not run: {e}", ""
    output = stdout + "\n" + stderr
    if code != 0:
        lines = [l.strip() for l in output.splitlines() if l.strip()]
        return (lines[-1] if lines else f"'claude {' '.join(args)}' exited {code}"), output
    return None, output

def _install_ideate_plugin(claude, market):
    """Install ideate@claude-pool into the shared plugins and settings, via a
    config folder that holds only links to them. Returns an error line or None."""
    host = SHARED / ".plugin-host"
    host.mkdir(exist_ok=True)
    _link_into(host, "plugins", SHARED / "plugins")
    _link_into(host, "settings.json", SHARED / "settings.json")
    env = os.environ.copy()
    env["CLAUDE_CONFIG_DIR"] = str(host)
    commands = [["plugin", "marketplace", "add", str(market)]]
    # Uninstall before install when already installed: the plugin version only
    # changes with package.json, and `claude plugin install` (alone, or after
    # `claude plugin marketplace update claude-pool`) keeps the cached copy of
    # an installed version, so a changed skill would never reach the profiles.
    # Uninstalling drops a user's "disabled" setting, so it is put back after.
    was_disabled = _ideate_disabled()
    if _ideate_plugin_installed():
        commands.append(["plugin", "uninstall", "--keep-data", IDEATE_PLUGIN])
    commands.append(["plugin", "install", IDEATE_PLUGIN])
    error = None
    for args in commands:
        error, output = _run_claude(claude, args, env)
        if error and "--keep-data" in args and (
                "keep-data" in output or "unknown option" in output.lower()):
            # An older claude may not know --keep-data: try once without it.
            error, _ = _run_claude(claude, [a for a in args if a != "--keep-data"], env)
        if error:
            break
    # Put "disabled" back whenever it was dropped, even by a step that then
    # failed or timed out, so a later re-install doesn't come back enabled.
    if was_disabled and not _ideate_disabled():
        try:
            _disable_ideate()
        except OSError as e:
            print(f"ideate: could not restore the disabled setting ({e})")
    return error

def install_ideate(src_root):
    """Set up the ideate command and the /ideate:review plugin. Prints one
    line per step it can't do; never raises."""
    src_root = Path(src_root).resolve()
    market = BASE / "marketplace"
    if (src_root / "plugins" / "ideate").is_dir():
        _copy_marketplace(src_root, market)
    if not (market / "plugins" / "ideate").is_dir():
        print("ideate: not bundled with this copy; run setup.sh from the claude_pool clone")
        return
    # Written before the Node check: the copy above removed the old wrapper,
    # and existing ideate links must not be left dangling.
    wrapper = _write_ideate_wrapper(market)

    major, version = _node_version()
    if major is None or major < 20:
        print(f"ideate: needs Node 20 or newer (found {version}); skipped")
        return

    command_linked = _link_ideate(wrapper)

    plugin_installed = False
    claude = shutil.which("claude")
    if claude is None:
        print("ideate: 'claude' CLI not found; the /ideate:review command was not installed")
    else:
        error = _install_ideate_plugin(claude, market)
        if error:
            print(f"ideate: plugin install failed ({error}); re-run setup.sh to try again")
        else:
            plugin_installed = True

    if command_linked:
        print("ideate: command installed")
    else:
        print(f"ideate: command not linked into {BIN_DIR}; setup.sh links it from ~/bin")
    if plugin_installed:
        print("ideate: /ideate:review installed for linked profiles")
    else:
        print("ideate: /ideate:review not installed")
    for name in ["agy", "codex"]:
        if shutil.which(name):
            print(f"ideate: {name} found")
        else:
            print(f"ideate: {name} not found (reviews need it installed and logged in)")
    shared_plugins = (SHARED / "plugins").resolve()
    for a in load()["accounts"]:
        try:
            plugins = Path(config_dir(a)) / "plugins"
        except KeyError:
            continue
        if not (plugins.is_symlink() and plugins.resolve() == shared_plugins):
            print(f"ideate: profile '{a['name']}' is not linked to the shared layer; run 'claudes migrate' for it to see the plugin")

def install():
    ensure()
    target = BASE / "claudes"
    if Path(__file__).resolve() != target.resolve():
        shutil.copy2(Path(__file__), target)
    target.chmod(target.stat().st_mode | stat.S_IEXEC)
    link = BIN_DIR / "claudes"
    try:
        if link.exists() or link.is_symlink():
            link.unlink()
        link.symlink_to(target)
        print(f"Installed: {link}")
    except Exception:
        print("Add ~/.claudes to PATH manually")
    try:
        install_ideate(Path(__file__).resolve().parent)
    except Exception as e:
        print(f"ideate: skipped ({e or type(e).__name__})")
    print("Done")

def add(name):
    if not name.strip():
        print(f"{RED}Account name cannot be empty{RESET} — pick a name."); return
    if name in RESERVED:
        print(f"{RED}'{name}' is a reserved command name{RESET} — pick something else."); return
    d=load()
    if any(a["name"]==name for a in d["accounts"]):
        print("Already exists"); return
    p=PROFILES/name
    for a in d["accounts"]:
        try:
            cp=config_dir(a)
        except KeyError:
            continue
        if Path(cp).resolve()==p.resolve():
            print(f"{RED}Refusing: '{p}' is already used by account '{a['name']}'{RESET} — probably left behind by a rename. Run 'claudes remove {a['name']}' first, or pick a different name (renaming '{a['name']}' won't free this directory).")
            return
    p.mkdir(parents=True, exist_ok=True)
    d["accounts"].append({"name":name,"config_path":str(p)})
    save(d)
    setup_shared_links(str(p))
    print("Added", name)
    _login(name)

def remove(name, force=False):
    a=find(name)
    if not a:
        print("Not found"); return
    try:
        cp=config_dir(a)
    except KeyError:
        cp=None
    if cp and _has_active_sessions(cp):
        print(f"{RED}Claude is currently running under '{name}'{RESET} — close it first."); return
    if not force:
        if not sys.stdin.isatty():
            print(f"Refusing to remove '{name}' without confirmation (non-interactive) — pass --force."); return
        if input(f"Remove account '{name}' and delete its profile? [y/N] ").strip().lower()!="y":
            print("Cancelled"); return
    d=load()
    d["accounts"]=[x for x in d["accounts"] if x["name"]!=name]
    save(d)
    if CURRENT.exists() and CURRENT.read_text().strip()==name:
        CURRENT.unlink()
    if cp:
        try:
            resolved=Path(cp).resolve()
            resolved.relative_to(PROFILES.resolve())
        except ValueError:
            print(f"{YELLOW}{cp} is outside profiles/ — not deleting; remove it manually if desired.{RESET}")
        else:
            if resolved.is_dir():
                shutil.rmtree(str(resolved))
    print("Removed", name)

def rename(old, new):
    if not new.strip():
        print(f"{RED}Account name cannot be empty{RESET} — pick a name."); return
    if new in RESERVED:
        print(f"{RED}'{new}' is a reserved command name{RESET} — pick something else."); return
    d=load()
    if not any(a["name"]==old for a in d["accounts"]):
        print("Not found"); return
    if any(a["name"]==new for a in d["accounts"]):
        print("Already exists"); return
    for a in d["accounts"]:
        if a["name"]==old:
            a["name"]=new
    save(d)
    if CURRENT.exists() and CURRENT.read_text().strip()==old:
        CURRENT.write_text(new)
    print("Renamed", old, "to", new)

def list_accounts():
    d=load()
    for a in sorted(d["accounts"], key=lambda x:x["name"]):
        print(a["name"])

def _require_claude():
    if not shutil.which("claude"):
        print(f"{RED}claude CLI not found on PATH{RESET} — install it and log in once per account (see SETUP.md prerequisites).")
        return False
    return True

def launch(name):
    a=find(name)
    if not a:
        print("Not found"); return
    if not _require_claude():
        return
    CURRENT.write_text(name)
    _sync_last_session(name)
    env=os.environ.copy()
    env["CLAUDE_CONFIG_DIR"]=config_dir(a)
    sys.stdout.flush()
    subprocess.run(["claude"], env=env)

_LOGIN_URL_RE=re.compile(r"https?://[^\s\x00-\x1f\x7f]+")

def _login(name):
    """Run `claude auth login` directly under an account's config, so the
    login flow starts immediately instead of requiring /login to be typed
    inside an interactive session. Streams the command's output live; when
    the login URL appears, copy it to the clipboard (via pbcopy) instead of
    letting a browser tab open automatically, so the user can paste it into
    whichever browser they choose. Browser auto-open is only suppressed on
    a best-effort basis (BROWSER=true) — claude may still open one directly;
    the clipboard copy is the reliable part. While waiting, pressing Esc
    twice cancels the login and returns control to the caller.

    The child's stdout/stderr are attached to a pty rather than a plain
    pipe: `claude` fully buffers its output when it detects a non-tty
    stdout, so a plain pipe can sit silent indefinitely (the user sees only
    whatever partial output happened to flush, e.g. "Opening browser to
    sign in…", with the sign-in URL itself stuck in the buffer). A pty
    keeps it in normal line-buffered/tty output mode."""
    a=find(name)
    if not a:
        print("Not found"); return
    if not _require_claude():
        return
    env=os.environ.copy()
    env["CLAUDE_CONFIG_DIR"]=config_dir(a)
    env["BROWSER"]="true"
    sys.stdout.flush()
    master_fd,slave_fd=pty.openpty()
    p=subprocess.Popen(["claude","auth","login"], env=env,
                        stdout=slave_fd, stderr=slave_fd)
    os.close(slave_fd)

    can_cancel=sys.stdin.isatty()
    copied=False

    def handle_line(line):
        nonlocal copied
        m=_LOGIN_URL_RE.search(line)
        if m and not copied:
            url=m.group(0).rstrip(").,\"'")
            try:
                subprocess.run(["pbcopy"], input=url, text=True, check=True)
                print(f"\n  {GREEN}Login link copied to clipboard{RESET} — paste it into any browser to sign in:")
                print(f"  {url}")
                if can_cancel:
                    print("  (press Esc twice to cancel and pick a different account)")
                print()
                copied=True
                return
            except Exception:
                pass
        print(line, end="")

    old=None; fd=None
    if can_cancel:
        try:
            import termios, tty
            fd=sys.stdin.fileno()
            old=termios.tcgetattr(fd)
            tty.setcbreak(fd)
        except Exception:
            can_cancel=False

    cancelled=False
    last_esc=0.0
    buf=""

    def drain_master():
        nonlocal buf
        try:
            data=os.read(master_fd, 4096)
        except OSError:
            return False
        if not data:
            return False
        buf+=data.decode(errors="replace")
        while "\n" in buf:
            line,buf=buf.split("\n",1)
            handle_line(line+"\n")
        return True

    try:
        while True:
            if p.poll() is not None:
                while drain_master():
                    pass
                if buf:
                    handle_line(buf)
                    buf=""
                break
            fds=[master_fd]+([sys.stdin] if can_cancel else [])
            r,_,_=select.select(fds,[],[],0.2)
            if master_fd in r:
                drain_master()
            if can_cancel and sys.stdin in r:
                ch=sys.stdin.read(1)
                if ch=="\x1b":
                    now=time.time()
                    if now-last_esc<0.75:
                        cancelled=True
                        break
                    last_esc=now
    finally:
        if old is not None:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        os.close(master_fd)

    if cancelled:
        p.terminate()
        try:
            p.wait(timeout=2)
        except subprocess.TimeoutExpired:
            p.kill()
        print(f"\n  {YELLOW}Login cancelled.{RESET}")
    else:
        p.wait()

def get_usage(name):
    a=find(name)
    if not a: return {"session":0,"week":0,"active":False,"reason":"error"}
    env=os.environ.copy()
    try:
        env["CLAUDE_CONFIG_DIR"]=config_dir(a)
        r=subprocess.run(["claude","-p","/usage"],capture_output=True,text=True,env=env,timeout=60)
        out=r.stdout
        s=re.search(r"Current session:\s+(\d+)%", out)
        w=re.search(r"Current week.*?:\s+(\d+)%", out)
        wr=re.search(r"Current week.*?resets\s+([^\n]+)", out)
        if r.returncode!=0:
            return {"session":0,"week":0,"active":False,"reason":"expired"}
        if not s or not w:
            # `claude -p /usage` exits 0 even when the session has no working
            # credentials — it silently falls back to a generic zero-cost
            # stub instead of real percentages. That's indistinguishable from
            # a dead session, so treat it the same as an expired one (login
            # required) rather than a transient "error" the picker can't
            # recover from.
            return {"session":0,"week":0,"active":False,"reason":"expired"}
        return {"session":int(s.group(1)),"week":int(w.group(1)),"week_resets":wr.group(1).strip() if wr else "",
                "active":True}
    except subprocess.TimeoutExpired:
        return {"session":0,"week":0,"active":False,"reason":"timeout"}
    except Exception:
        return {"session":0,"week":0,"active":False,"reason":"error"}

def get_usage_all(names):
    """Check every named account's usage concurrently (one thread per
    account, each blocking on its own `claude -p /usage` subprocess).
    Returns a list of usage dicts in the same order as `names`; blocks
    until all complete, so the wait is bounded by the slowest single
    check rather than the sum of every account's check time."""
    if not names:
        return []
    with ThreadPoolExecutor(max_workers=len(names)) as ex:
        return list(ex.map(get_usage, names))

def color(v):
    if v>=80: return RED
    if v>=50: return YELLOW
    return GREEN

def usage():
    d=load()
    names=[a["name"] for a in d["accounts"]]
    if names and not _require_claude():
        return
    if names:
        print(f"Checking {len(names)} account{'s' if len(names)!=1 else ''}...")
    results=get_usage_all(names)
    rows=[]; expired=[]; failed=[]
    for name,u in zip(names,results):
        if not u["active"]:
            if u.get("reason")=="expired": expired.append(name)
            else: failed.append(name)
            continue
        score=u["session"]*0.7+u["week"]*0.3
        rows.append((name,u["session"],u["week"],score,u.get("week_resets","")))
    rows.sort(key=lambda x:x[3])
    print("\nCLAUDE ACCOUNT USAGE\n")
    print(f"{'Account':12} {'Session':10} {'Weekly':10} {'Score':7} Week resets")
    print("-"*70)
    for n,s,w,sc,wr in rows:
        c=color(s)
        print(f"{n:12} {c}{s:>3}%{RESET}       {c}{w:>3}%{RESET}      {sc:<7.1f} {wr}")
    for n in expired:
        print(f"{n:12} {RED}{'expired':>7}{RESET}    {RED}{'expired':>7}{RESET}    -")
    for n in failed:
        print(f"{n:12} {YELLOW}{'check failed':>12}{RESET} {YELLOW}{'check failed':>12}{RESET} -")
    if rows:
        print(f"\nBest Account: {rows[0][0]}")
    elif expired and not failed:
        print("\nAll accounts have expired sessions — run 'claudes' and pick one under \"Login required\" to log back in.")
    elif failed and not expired:
        print("\nCould not check any account (timeout/network) — try again.")
    elif expired and failed:
        print(f"\n{', '.join(expired)} have expired sessions — run 'claudes' and pick one under \"Login required\" to log back in. {', '.join(failed)} could not be checked — try again.")

def _interactive_menu(rows, expired):
    """Keyboard-navigable grid: Up/Down move within a column, Left/Right
    switch column (only when both are present), Enter chooses, q/Ctrl-C
    cancels. `rows` (active, sorted best-first) render under "Available";
    `expired` names render under "Login required" — side by side when both
    are non-empty, otherwise as a single column. Returns ("use", name) for
    a chosen active account, ("login", name) for a chosen login-required
    one, or None if cancelled or raw terminal input isn't available."""
    try:
        import termios, tty
    except ImportError:
        return None

    if not rows and not expired:
        return None
    two_col=bool(rows) and bool(expired)
    col=0 if rows else 1
    row=0

    def plain_row(name,u,sc):
        return f"{name:12} session {u['session']:>3}%  week {u['week']:>3}%  score {sc:5.1f}  resets {u.get('week_resets','')}"

    def colored_row(name,u,sc):
        c=color(u["session"])
        return f"{name:12} session {c}{u['session']:>3}%{RESET}  week {c}{u['week']:>3}%{RESET}  score {sc:5.1f}  resets {u.get('week_resets','')}"

    def plain_login(name):
        return f"{name:12} (Enter to log in)"

    box_w_avail=max((len(plain_row(n,u,sc)) for n,u,sc in rows), default=0)
    box_w_login=max((len(plain_login(n)) for n in expired), default=0)

    def box_lines(plain,colored,width,selected):
        pad=" "*(width-len(plain))
        if selected:
            content=f"\033[7m{plain}{pad}{RESET}"
            bc=GREEN
        else:
            content=colored+pad
            bc=GRAY
        hbar="─"*(width+2)
        return [
            f"{bc}┌{hbar}┐{RESET}",
            f"{bc}│{RESET} {content} {bc}│{RESET}",
            f"{bc}└{hbar}┘{RESET}",
        ]

    GAP="    "

    def render():
        if two_col:
            lines=["Select an account (↑/↓ move, ←/→ switch, Enter choose, q cancel):",""]
        else:
            lines=["Select an account (↑/↓ move, Enter choose, q cancel):",""]

        avail_blocks=[box_lines(plain_row(n,u,sc), colored_row(n,u,sc), box_w_avail, col==0 and row==i)
                      for i,(n,u,sc) in enumerate(rows)]
        login_blocks=[box_lines(plain_login(n), f"{RED}{plain_login(n)}{RESET}", box_w_login, col==1 and row==j)
                      for j,n in enumerate(expired)]

        full_avail=box_w_avail+4
        full_login=box_w_login+4

        if two_col:
            lines.append(f"{'Available:':<{full_avail}}{GAP}Login required:")
            for i in range(max(len(avail_blocks), len(login_blocks))):
                a=avail_blocks[i] if i<len(avail_blocks) else [" "*full_avail]*3
                b=login_blocks[i] if i<len(login_blocks) else [" "*full_login]*3
                for la,lb in zip(a,b):
                    lines.append(la+GAP+lb)
        elif rows:
            lines.append("Available:")
            for b in avail_blocks: lines+=b
        else:
            lines.append("Login required:")
            for b in login_blocks: lines+=b
        return lines

    fd=sys.stdin.fileno()
    old=termios.tcgetattr(fd)
    lines=render()
    print("\n".join(lines))
    result=None
    try:
        tty.setraw(fd)
        while True:
            ch=sys.stdin.read(1)
            key=None
            if ch=="\x1b":
                if sys.stdin.read(1)=="[":
                    key={"A":"up","B":"down","C":"right","D":"left"}.get(sys.stdin.read(1))
            elif ch in ("\r","\n"):
                key="enter"
            elif ch in ("\x03","q","Q"):
                key="cancel"

            if key=="enter":
                name=rows[row][0] if col==0 else expired[row]
                result=("use" if col==0 else "login", name)
                break
            if key=="cancel":
                result=None
                break
            moved=False
            if key in ("up","down"):
                n=len(rows) if col==0 else len(expired)
                row=(row-1)%n if key=="up" else (row+1)%n
                moved=True
            elif key in ("left","right") and two_col:
                col=1-col
                other_n=len(rows) if col==0 else len(expired)
                row=min(row, other_n-1)
                moved=True
            if moved:
                sys.stdout.write(f"\033[{len(lines)}A\r")
                lines=render()
                for l in lines:
                    sys.stdout.write("\033[2K"+l+"\r\n")
                sys.stdout.flush()
    except KeyboardInterrupt:
        result=None
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
    return result

def _choose_account():
    """Check every account's session and usage concurrently (bounded by
    the slowest single check, not the sum of all), then offer an
    arrow-key menu: active accounts under "Available" (best score
    first), expired ones under "Login required" — picking one of those
    launches claude so you can log back in, then re-checks everything.
    Returns the chosen account name."""
    d=load()
    accounts=d["accounts"]
    if not accounts:
        print("No accounts")
        return None

    if not _require_claude():
        return None

    names=[a["name"] for a in accounts]
    print(f"Checking {len(names)} account{'s' if len(names)!=1 else ''}...")
    results=get_usage_all(names)

    rows=[]
    expired=[]
    failed=[]
    for name,u in zip(names,results):
        if not u["active"]:
            if u.get("reason")=="expired":
                print(f"  {RED}✗ {name:12} session expired{RESET}")
                expired.append(name)
            else:
                print(f"  {YELLOW}⚠ {name:12} check failed — {u.get('reason')}, try again{RESET}")
                failed.append(name)
            continue
        sc=u["session"]*0.7+u["week"]*0.3
        rows.append((name,u,sc))
        c=color(u["session"])
        print(f"  {GREEN}✓{RESET} {name:12} session {c}{u['session']:>3}%{RESET}  week {c}{u['week']:>3}%{RESET}  score {sc:5.1f}  resets {u.get('week_resets','')}")

    rows.sort(key=lambda r: r[2])
    print()

    if rows:
        print(f"Recommended: {rows[0][0]} — lowest score {rows[0][2]:.1f} among active sessions (70% session + 30% weekly usage)\n")
        if not sys.stdin.isatty():
            return rows[0][0]
    else:
        msg="No accounts with an active session."
        if expired:
            msg+=f" ({', '.join(expired)} need a fresh login.)"
        if failed:
            msg+=f" ({', '.join(failed)} could not be checked — try again.)"
        print(msg)
        if not sys.stdin.isatty() or not expired:
            return None

    choice=_interactive_menu(rows, expired)
    if choice is None:
        return None
    kind,name=choice
    if kind=="use":
        return name
    _login(name)
    return _choose_account()

def migrate(dry_run=False):
    """Set up shared session layer and import all historical data.

    With dry_run, nothing is written: it prints what would be linked and imported."""
    if dry_run:
        print(f"{YELLOW}Dry run{RESET} — nothing will be changed.\n")
        try:
            d = json.loads(ACCOUNTS.read_text())
        except FileNotFoundError:
            d = {"accounts": []}
    else:
        ensure()
        d = load()
    print("Setting up shared session layer...\n")

    registered_paths = {config_dir(a) for a in d["accounts"] if "config_path" in a or "path" in a}

    for a in d["accounts"]:
        try:
            cp = config_dir(a)
        except KeyError:
            continue
        print(f"  Linking {a['name']} ({cp})...")
        setup_shared_links(cp, dry_run=dry_run)

    # Fold the default `claude` config (used when CLAUDE_CONFIG_DIR isn't set)
    # into the shared layer too, so plain `claude` stays in sync with every
    # pool account from now on — not just a one-time snapshot.
    default_claude = HOME / ".claude"
    if str(default_claude) not in registered_paths and default_claude.is_dir():
        print("  Linking ~/.claude (default config)...")
        setup_shared_links(default_claude, dry_run=dry_run)

    print("\nImporting remaining historical session data...")
    names = [a["name"] for a in d["accounts"]]
    sources = []

    # Old per-name dirs directly under ~/.claudes/ (stale from earlier setup)
    claudes_default = HOME / ".claudes"
    for name in names:
        p = claudes_default / name
        if p.is_dir() and not p.is_symlink() and str(p) not in registered_paths:
            sources.append(p)

    # Stale per-account sub-dirs left under ~/.claude from earlier setups
    # (~/.claude itself is handled above via setup_shared_links, not here)
    for name in names:
        for sub in [default_claude / name, default_claude / "profiles" / name]:
            if sub.is_dir() and not sub.is_symlink() and str(sub) not in registered_paths:
                sources.append(sub)

    total_s = total_h = 0
    for src in sources:
        ns = _merge_projects(src / "projects", SHARED / "projects", dry_run=dry_run)
        nh = _merge_history(src / "history.jsonl", SHARED / "history.jsonl", dry_run=dry_run)
        if ns or nh:
            would = "would import " if dry_run else ""
            print(f"  {src}: {would}{ns} sessions (projects), {nh} history entries")
        total_s += ns
        total_h += nh

    if dry_run:
        print(f"\nDry run done. {total_s} session files and {total_h} history entries would be imported; nothing was changed.")
        return
    print(f"\nDone. {total_s} session files imported, {total_h} history entries merged.")
    print(f"Shared layer: {SHARED}")


if __name__=="__main__":
    cmd=sys.argv[1] if len(sys.argv)>1 else ""
    if cmd=="install": install()
    elif cmd=="add" and len(sys.argv)>2: add(sys.argv[2])
    elif cmd=="add": print("Usage: claudes add <name>")
    elif cmd=="remove" and len(sys.argv)>2: remove(sys.argv[2], force="--force" in sys.argv[3:])
    elif cmd=="remove": print("Usage: claudes remove <name> [--force]")
    elif cmd=="rename" and len(sys.argv)>3: rename(sys.argv[2], sys.argv[3])
    elif cmd=="rename": print("Usage: claudes rename <old> <new>")
    elif cmd=="list": list_accounts()
    elif cmd=="usage": usage()
    elif cmd=="migrate": migrate(dry_run="--dry-run" in sys.argv[2:])
    elif cmd=="":
        acc=_choose_account()
        if acc: launch(acc)
    elif find(cmd):
        launch(cmd)
    else:
        print("Commands: install, add <name>, remove <name> [--force], rename <old> <new>, list, usage, migrate")
        print("Run 'claudes' with no arguments to pick an account and launch it.")
        print("Run 'claudes <name>' to launch a specific account directly.")
        names=sorted(a["name"] for a in load()["accounts"])
        if names:
            print(f"Configured accounts: {', '.join(names)}")

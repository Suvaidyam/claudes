/**
 * `claudes install` (claudes.py at the repo root) sets up the ideate command and plugin.
 *
 * Every run is sandboxed: CLAUDES_BASE, CLAUDES_BIN_DIR and HOME point into a temp folder, and
 * PATH holds only symlinks to the tools a case allows, so the real ~/.claudes, /usr/local/bin
 * and shell rc files are never touched. claude only ever runs with CLAUDE_CONFIG_DIR in the temp
 * folder (the installer's own plugin host, or a test profile).
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const TIMEOUT = 300_000;

/** Absolute path of a tool on the test runner's PATH, or undefined. */
function tool(name: string): string | undefined {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", timeout: 10_000 });
  const p = r.stdout.trim();
  return r.status === 0 && p.startsWith("/") ? realpathSync(p) : undefined;
}

const hasClaude = tool("claude") !== undefined;
const out = (r: SpawnSyncReturns<string>) => `${r.stdout}${r.stderr}`;

interface Sandbox {
  tmp: string;
  base: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  install(script?: string): SpawnSyncReturns<string>;
  run(cmd: string, args: string[], extra?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
}

/** A temp base, bin folder and HOME, with PATH limited to python3, sh, env and `tools`. */
function sandbox(tools: string[]): Sandbox {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "claudes-install-")));
  const toolDir = join(tmp, "tools");
  const bin = join(tmp, "bin");
  const home = join(tmp, "home");
  for (const d of [toolDir, bin, home]) mkdirSync(d);
  for (const name of ["python3", "sh", "env", ...tools]) {
    const p = tool(name);
    assert.ok(p, `${name} is not installed`);
    symlinkSync(p, join(toolDir, name));
  }
  const base = join(tmp, "base");
  const env: NodeJS.ProcessEnv = {
    CLAUDES_BASE: base, CLAUDES_BIN_DIR: bin, HOME: home, PATH: toolDir, TMPDIR: tmp,
  };
  const run = (cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(cmd, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: TIMEOUT });
  return {
    tmp, base, bin, env, run,
    install: (script = join(root, "claudes.py")) => run(join(toolDir, "python3"), [script, "install"]),
  };
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** A config folder linked to the shared layer the way `claudes add` links a profile. */
function linkedProfile(s: Sandbox, name: string): string {
  const prof = join(s.tmp, name);
  mkdirSync(prof);
  symlinkSync(join(s.base, "shared", "plugins"), join(prof, "plugins"));
  symlinkSync(join(s.base, "shared", "settings.json"), join(prof, "settings.json"));
  return prof;
}

describe("full install", { skip: !hasClaude && "claude is not installed" }, () => {
  const s = sandbox(["node", "claude"]);
  let first: SpawnSyncReturns<string>;

  test("installs the command and the plugin", () => {
    first = s.install();
    assert.equal(first.status, 0, out(first));
    assert.equal(realpathSync(join(s.bin, "ideate")), realpathSync(join(s.base, "marketplace", "ideate")));
    const list = s.run(join(s.bin, "ideate"), ["list"]);
    assert.equal(list.status, 0, out(list));
    assert.ok(existsSync(join(s.base, "shared", "ideate", "config.json")));
    const installed = readJson(join(s.base, "shared", "plugins", "installed_plugins.json"));
    assert.ok(installed.plugins["ideate@claude-pool"], JSON.stringify(installed));
    const settings = readJson(join(s.base, "shared", "settings.json"));
    assert.equal(settings.enabledPlugins["ideate@claude-pool"], true);
    assert.ok(existsSync(join(s.base, "shared", ".plugin-host")));
  });

  test("reports what it did", () => {
    const text = out(first);
    assert.match(text, /^ideate: command installed$/m);
    assert.match(text, /^ideate: \/ideate:review installed for linked profiles$/m);
    assert.match(text, /^ideate: agy not found \(reviews need it installed and logged in\)$/m);
    assert.match(text, /^ideate: codex not found \(reviews need it installed and logged in\)$/m);
  });

  test("a linked profile sees the plugin", () => {
    const prof = linkedProfile(s, "prof");
    const list = s.run("claude", ["plugin", "list"], { CLAUDE_CONFIG_DIR: prof });
    assert.equal(list.status, 0, out(list));
    assert.ok(list.stdout.includes("ideate@claude-pool"), list.stdout);
    assert.ok(list.stdout.includes("enabled"), list.stdout);
  });

  test("a stale file in the marketplace copy is removed on re-run", () => {
    const stale = join(s.base, "marketplace", "plugins", "ideate", "stale.txt");
    writeFileSync(stale, "old");
    const again = s.install();
    assert.equal(again.status, 0, out(again));
    assert.ok(!existsSync(stale));
  });

  test("the installed copy re-runs install", () => {
    const again = s.install(join(s.base, "claudes"));
    assert.equal(again.status, 0, out(again));
    assert.ok(existsSync(join(s.base, "marketplace", "plugins", "ideate", "bin", "ideate.mjs")));
    assert.ok(existsSync(join(s.base, "marketplace", ".claude-plugin", "marketplace.json")));
    assert.equal(realpathSync(join(s.bin, "ideate")), realpathSync(join(s.base, "marketplace", "ideate")));
  });
});

test("re-running install delivers a changed skill", { skip: !hasClaude && "claude is not installed" }, () => {
  const s = sandbox(["node", "claude"]);
  const src = join(s.tmp, "src");
  mkdirSync(src);
  for (const p of [".claude-plugin", "plugins", "claudes.py"]) cpSync(join(root, p), join(src, p), { recursive: true });
  const script = join(src, "claudes.py");
  const one = s.install(script);
  assert.equal(one.status, 0, out(one));
  appendFileSync(join(src, "plugins", "ideate", "skills", "review", "SKILL.md"), "\nMARKER-2\n");
  const two = s.install(script);
  assert.equal(two.status, 0, out(two));

  // Claude Code may read the plugin in place (`Read from:`) or from its cache (`installPath`);
  // whichever this install reports must hold the change.
  const prof = linkedProfile(s, "prof");
  const list = s.run("claude", ["plugin", "list"], { CLAUDE_CONFIG_DIR: prof });
  assert.equal(list.status, 0, out(list));
  const readFrom = /Read from:\s*(\S+)/.exec(list.stdout)?.[1];
  const installed = readJson(join(s.base, "shared", "plugins", "installed_plugins.json"));
  const installPath: string | undefined = installed.plugins["ideate@claude-pool"]?.[0]?.installPath;
  const dirs = [readFrom, installPath].filter((d): d is string => !!d);
  assert.ok(dirs.length > 0, list.stdout);
  for (const d of dirs) {
    const skill = readFileSync(join(d, "skills", "review", "SKILL.md"), "utf8");
    assert.ok(skill.includes("MARKER-2"), `${d} has the old SKILL.md`);
  }
});

test("Node hidden: install still succeeds and skips ideate", () => {
  const s = sandbox([]);
  const r = s.install();
  assert.equal(r.status, 0, out(r));
  assert.ok(out(r).includes("needs Node 20"), out(r));
  assert.ok(existsSync(join(s.base, "claudes")));
  assert.ok(!lstatExists(join(s.bin, "ideate")));
});

test("claude hidden: the command is installed, the plugin is skipped", () => {
  const s = sandbox(["node"]);
  const r = s.install();
  assert.equal(r.status, 0, out(r));
  assert.ok(out(r).includes("'claude' CLI not found"), out(r));
  assert.match(out(r), /^ideate: \/ideate:review not installed$/m);
  const list = s.run(join(s.bin, "ideate"), ["list"]);
  assert.equal(list.status, 0, out(list));
});

test("an account not linked to the shared layer is named", () => {
  const s = sandbox(["node"]);
  const loose = join(s.tmp, "loose");
  mkdirSync(join(loose, "plugins"), { recursive: true });
  const linked = linkedProfile(s, "linked-prof");
  mkdirSync(s.base);
  mkdirSync(join(s.base, "shared", "plugins"), { recursive: true });
  writeFileSync(join(s.base, "shared", "settings.json"), "{}");
  writeFileSync(join(s.base, "accounts.json"), JSON.stringify({
    accounts: [{ name: "loose", config_path: loose }, { name: "linked", config_path: linked }],
  }));
  const r = s.install();
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /^ideate: profile 'loose' is not linked to the shared layer; run 'claudes migrate' for it to see the plugin$/m);
  assert.ok(!out(r).includes("profile 'linked'"), out(r));
});

test("claudes.py imports only the standard library", () => {
  const check = [
    "import ast, sys",
    "tree = ast.parse(open(sys.argv[1]).read())",
    "names = set()",
    "for n in ast.walk(tree):",
    "    if isinstance(n, ast.Import): names.update(a.name.split('.')[0] for a in n.names)",
    "    elif isinstance(n, ast.ImportFrom) and n.level == 0: names.add(n.module.split('.')[0])",
    "bad = sorted(names - set(sys.stdlib_module_names))",
    "print(bad); sys.exit(1 if bad else 0)",
  ].join("\n");
  const r = spawnSync("python3", ["-c", check, join(root, "claudes.py")], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, out(r));
});

test("setup.sh parses", () => {
  const r = spawnSync("bash", ["-n", join(root, "setup.sh")], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, out(r));
});

/** Run setup.sh's PATH_LINE and function definitions (not the script) and then `body`, in a sandboxed bash. */
function setupFunctions(body: string, env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  const lines = readFileSync(join(root, "setup.sh"), "utf8").split("\n");
  const defs: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (/^PATH_LINE=/.test(line)) defs.push(line);
    if (/^[a-z_]+\(\) \{$/.test(line)) inside = true;
    if (inside) defs.push(line);
    if (inside && line === "}") inside = false;
  }
  return spawnSync(tool("bash")!, ["-c", `set -euo pipefail\n${defs.join("\n")}\n${body}`], {
    env, encoding: "utf8", timeout: 30_000,
  });
}

describe("setup.sh ideate block", () => {
  function fixture(otherIdeate: boolean) {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "setup-ideate-")));
    const home = join(tmp, "home");
    const base = join(tmp, "base");
    const toolDir = join(tmp, "tools");
    mkdirSync(join(base, "marketplace"), { recursive: true });
    mkdirSync(home);
    mkdirSync(toolDir);
    writeFileSync(join(base, "marketplace", "ideate"), "#!/bin/sh\necho wrapper\n", { mode: 0o755 });
    for (const t of ["mkdir", "ln", "grep", "readlink", "cat", "dirname"]) {
      const p = tool(t);
      if (p) symlinkSync(p, join(toolDir, t));
    }
    if (otherIdeate) writeFileSync(join(toolDir, "ideate"), "#!/bin/sh\n", { mode: 0o755 });
    const env = { HOME: home, PATH: toolDir, SHELL: "/bin/zsh" };
    return { tmp, home, base, env };
  }

  test("links ~/bin/ideate and adds the PATH line once", () => {
    const f = fixture(false);
    const body = `BASE_DIR=${JSON.stringify(f.base)}; NEEDS_RELAUNCH=0; RC_FILE=""\n` +
      `link_ideate\nlink_ideate\necho "relaunch=$NEEDS_RELAUNCH rc=$RC_FILE"`;
    const r = setupFunctions(body, f.env);
    assert.equal(r.status, 0, out(r));
    assert.equal(realpathSync(join(f.home, "bin", "ideate")), join(f.base, "marketplace", "ideate"));
    const rc = readFileSync(join(f.home, ".zshrc"), "utf8");
    assert.equal(rc.split('export PATH="$HOME/bin:$HOME/.claudes:$PATH"').length - 1, 1, rc);
    assert.ok(r.stdout.includes(`relaunch=1 rc=${join(f.home, ".zshrc")}`), r.stdout);
    assert.ok(!r.stdout.includes("different 'ideate'"), r.stdout);
  });

  test("names a different ideate earlier on PATH", () => {
    const f = fixture(true);
    const body = `BASE_DIR=${JSON.stringify(f.base)}; NEEDS_RELAUNCH=0; RC_FILE=""\nlink_ideate`;
    const r = setupFunctions(body, f.env);
    assert.equal(r.status, 0, out(r));
    assert.ok(r.stdout.includes(`Note: a different 'ideate' is earlier on PATH: ${join(f.tmp, "tools", "ideate")}`), r.stdout);
    assert.ok(lstatSync(join(f.home, "bin", "ideate")).isSymbolicLink());
  });

  test("does nothing when the wrapper is missing", () => {
    const f = fixture(false);
    const body = `BASE_DIR=${JSON.stringify(join(f.tmp, "nowhere"))}; NEEDS_RELAUNCH=0; RC_FILE=""\nlink_ideate\necho "relaunch=$NEEDS_RELAUNCH"`;
    const r = setupFunctions(body, f.env);
    assert.equal(r.status, 0, out(r));
    assert.ok(r.stdout.includes("relaunch=0"), r.stdout);
    assert.ok(!existsSync(join(f.home, "bin")));
  });
});

function lstatExists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

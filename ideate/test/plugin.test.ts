/** The repo is a plugin marketplace; plugins/ideate is the plugin with its review skill. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

test("marketplace lists the ideate plugin", () => {
  const m = readJson(".claude-plugin/marketplace.json");
  assert.equal(m.name, "claude-pool");
  assert.equal(m.plugins.length, 1);
  assert.equal(m.plugins[0].name, "ideate");
  assert.equal(m.plugins[0].source, "./plugins/ideate");
});

test("plugin version matches package.json", () => {
  const p = readJson("plugins/ideate/.claude-plugin/plugin.json");
  assert.equal(p.name, "ideate");
  assert.equal(p.version, readJson("ideate/package.json").version);
});

test("review skill is named review and is path-free", () => {
  const text = readFileSync(join(root, "plugins/ideate/skills/review/SKILL.md"), "utf8");
  assert.match(text, /^---\n[\s\S]*?^name: review$/m);
  assert.ok(text.includes("--proposal"));
  assert.ok(text.includes("--rounds 1"));
  assert.ok(!text.includes("/Users/"));
  assert.ok(!text.includes(" cd "));
});

const hasClaude = spawnSync("claude", ["--version"], {
  env: { ...process.env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "ideate-plugin-probe-")) }, timeout: 30000,
}).status === 0;
test("claude can add the marketplace and install the plugin", { skip: !hasClaude }, () => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "ideate-plugin-")) };
  const claude = (args: string[]) =>
    spawnSync("claude", args, { env, encoding: "utf8", timeout: 120000 });
  const add = claude(["plugin", "marketplace", "add", root]);
  assert.equal(add.status, 0, add.stdout + add.stderr);
  const install = claude(["plugin", "install", "ideate@claude-pool"]);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const list = claude(["plugin", "list"]);
  assert.equal(list.status, 0, list.stdout + list.stderr);
  assert.ok(list.stdout.includes("ideate@claude-pool"), list.stdout);
});

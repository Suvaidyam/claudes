#!/usr/bin/env node
/**
 * Builds what runs on a machine with only Node, into <out> (default ../plugins/ideate):
 *   bin/ideate.mjs       the CLI and its dependencies in one ESM file (esbuild)
 *   web/                 the built chat app (vite)
 *   config.example.json  copied beside bin/, where home.ts looks for it
 * Only those three paths are written; anything else under <out> is left alone.
 *
 * --check builds into a temp folder and compares it with <out> file by file; on a difference it
 * lists the differing paths and exits 1.
 *
 * Usage: node scripts/bundle.mjs [--out <dir>] [--check]
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUTS = ["bin/ideate.mjs", "web", "config.example.json"];

async function bundle(out) {
  const cli = join(out, "bin", "ideate.mjs");
  const web = join(out, "web");
  rmSync(cli, { force: true });
  rmSync(web, { recursive: true, force: true });

  await build({
    absWorkingDir: ROOT,
    entryPoints: ["src/cli.ts"],
    outfile: cli,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
    // Some CommonJS dependencies (mute-stream, iconv-lite, used by the continue wizard) require()
    // Node built-ins, which an ESM bundle can't do without a real require.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  chmodSync(cli, 0o755);

  const vite = spawnSync(process.execPath, [
    join(ROOT, "node_modules", "vite", "bin", "vite.js"),
    "build", "--config", "ui/vite.config.ts", "--outDir", web, "--emptyOutDir", "--logLevel", "warn",
  ], { cwd: ROOT, encoding: "utf8" });
  if (vite.status !== 0) throw new Error(`vite build failed:\n${vite.stdout}${vite.stderr}`);

  copyFileSync(join(ROOT, "config.example.json"), join(out, "config.example.json"));
}

/** Every file under `path` (or `path` itself), relative to `base`; [] when missing. */
function files(base, path) {
  const full = join(base, path);
  const stat = statSync(full, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory()) return [path];
  return readdirSync(full, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(base, join(e.parentPath, e.name)).split("\\").join("/"));
}

function differences(expected, actual) {
  const paths = new Set(OUTPUTS.flatMap((p) => [...files(expected, p), ...files(actual, p)]));
  return [...paths].sort().filter((p) => {
    const a = join(expected, p);
    const b = join(actual, p);
    return !existsSync(a) || !existsSync(b) || !readFileSync(a).equals(readFileSync(b));
  });
}

const { values } = parseArgs({ options: { out: { type: "string" }, check: { type: "boolean", default: false } } });
const out = resolve(values.out ?? join(ROOT, "..", "plugins", "ideate"));
const shown = relative(process.cwd(), out).startsWith("..") ? out : relative(process.cwd(), out) || ".";

try {
  if (values.check) {
    const tmp = mkdtempSync(join(tmpdir(), "ideate-bundle-check-"));
    try {
      await bundle(tmp);
      const diff = differences(tmp, out);
      if (diff.length > 0) {
        console.error(`The bundle in ${shown} is out of date:`);
        for (const p of diff) console.error(`  ${p}`);
        console.error("Run: npm run bundle");
        process.exitCode = 1;
      } else {
        console.log("bundle: up to date");
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    mkdirSync(out, { recursive: true });
    await bundle(out);
    console.log(`bundle: wrote ${OUTPUTS.join(", ")} under ${shown}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

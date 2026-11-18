/**
 * The committed bundle (scripts/bundle.mjs): bin/ideate.mjs, web/ and config.example.json must run
 * on a machine with only Node, so they're exercised from a copy with no node_modules above it.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const temps: string[] = [];
const servers: ChildProcess[] = [];
const runsDirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function bundle(out: string): void {
  const res = spawnSync(process.execPath, [join(ROOT, "scripts", "bundle.mjs"), "--out", out], { cwd: ROOT, encoding: "utf8" });
  assert.equal(res.status, 0, `bundle failed:\n${res.stdout}\n${res.stderr}`);
}

/** Every file under dir, as sorted paths relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

let copy = "";
before(() => {
  const built = join(temp("ideate-bundle-"), "p");
  bundle(built);
  // tmpdir has no node_modules above it, so the copy can only use what the bundle carries.
  copy = join(temp("ideate-bundle-copy-"), "ideate");
  cpSync(built, copy, { recursive: true });
});

after(() => {
  for (const s of servers) s.kill("SIGKILL");
  for (const runsDir of runsDirs) {
    if (!existsSync(runsDir)) continue;
    for (const id of readdirSync(runsDir)) {
      try {
        process.kill(JSON.parse(readFileSync(join(runsDir, id, "worker.json"), "utf8")).pid, "SIGKILL");
      } catch { /* no worker */ }
    }
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A data home holding a mock config, plus an empty claudes base so nothing reads the real ~/.claudes. */
function mockHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = temp("ideate-bundle-home-");
  const mock = { type: "mock" };
  writeFileSync(join(home, "config.json"), JSON.stringify({
    primary: "p", secondaries: ["a", "b"], loop: { maxRounds: 2 }, providers: { p: mock, a: mock, b: mock },
  }));
  runsDirs.push(join(home, "runs"));
  return { home, env: envFor(home) };
}

function envFor(home: string): NodeJS.ProcessEnv {
  return { ...process.env, IDEATE_HOME: home, CLAUDES_BASE: temp("ideate-bundle-base-") };
}

const ideate = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync(process.execPath, [join(copy, "bin", "ideate.mjs"), ...args], { cwd: copy, env, encoding: "utf8" });

test("the bundle runs a review from a folder with no node_modules", () => {
  const { home, env } = mockHome();
  const res = ideate(env, "run", "--proposal", "plan", "--rounds", "1", "--id", "b1");
  assert.equal(res.status, 2, res.stderr);
  assert.ok(existsSync(join(home, "runs", "b1", "round-1", "review-a.json")));
});

test("the bundle serves the web app and starts workers from itself", async () => {
  const { env } = mockHome();
  const server = spawn(process.execPath, [join(copy, "bin", "ideate.mjs"), "ui", "--port", "0", "--no-open"], { cwd: copy, env });
  servers.push(server);
  let stderr = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no URL from ideate ui:\n${stderr}`)), 20000);
    server.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const m = /http:\/\/127\.0\.0\.1:\d+/.exec(stderr);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`ideate ui exited ${code}:\n${stderr}`)); });
  });

  const page = await fetch(url + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root">/);

  const created = await fetch(url + "/api/ideas", {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ brief: "x", rounds: 1 }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = (await created.json()) as { id: string };

  const end = Date.now() + 30000;
  for (;;) {
    const res = await fetch(`${url}/api/ideas/${id}`);
    const d = res.status === 200 ? ((await res.json()) as { state: { status: string }; summary: { active: unknown } }) : undefined;
    if (d && d.state.status !== "running" && !d.summary.active) {
      assert.ok(["converged", "max_rounds", "stagnated"].includes(d.state.status), `ended as ${d.state.status}`);
      break;
    }
    if (Date.now() > end) throw new Error(`idea ${id} never reached a final status`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

test("the bundle seeds config.json from the example beside it", () => {
  const home = temp("ideate-bundle-empty-");
  const res = ideate(envFor(home), "list");
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(home, "config.json")));
});

test("building twice gives byte-identical output", () => {
  const again = join(temp("ideate-bundle-again-"), "p");
  bundle(again);
  assert.ok(readFileSync(join(copy, "bin", "ideate.mjs")).equals(readFileSync(join(again, "bin", "ideate.mjs"))), "bin/ideate.mjs differs");
  const web = files(join(copy, "web"));
  assert.ok(web.includes("index.html"));
  assert.deepEqual(files(join(again, "web")), web);
  for (const f of web) {
    assert.ok(readFileSync(join(copy, "web", f)).equals(readFileSync(join(again, "web", f))), `web/${f} differs`);
  }
});

test("--check lists what differs from a fresh build and exits 1", () => {
  const out = join(temp("ideate-bundle-check-"), "p");
  cpSync(copy, out, { recursive: true });
  writeFileSync(join(out, "web", "index.html"), "stale");
  rmSync(join(out, "config.example.json"));
  const res = spawnSync(process.execPath, [join(ROOT, "scripts", "bundle.mjs"), "--check", "--out", out], { cwd: ROOT, encoding: "utf8" });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  const said = res.stdout + res.stderr;
  assert.match(said, /web\/index\.html/);
  assert.match(said, /config\.example\.json/);
  assert.doesNotMatch(said, /bin\/ideate\.mjs/);
  assert.match(said, /Run: npm run bundle/);
});

test("bundling touches nothing under --out but its own outputs", () => {
  const out = join(temp("ideate-bundle-keep-"), "p");
  mkdirSync(join(out, "skills"), { recursive: true });
  writeFileSync(join(out, "skills", "keep.md"), "kept");
  mkdirSync(join(out, "web"), { recursive: true });
  writeFileSync(join(out, "web", "stale.js"), "old");
  bundle(out);
  assert.equal(readFileSync(join(out, "skills", "keep.md"), "utf8"), "kept");
  assert.ok(!existsSync(join(out, "web", "stale.js")), "web/ is rebuilt from scratch");
  assert.ok(existsSync(join(out, "config.example.json")));
});

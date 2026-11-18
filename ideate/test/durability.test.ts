/**
 * The spec's anti-goal end to end: closing the browser or stopping `ideate ui` never stops a run or
 * loses text an agent has already written, and a killed worker can be resumed without losing it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readLive, type LiveEvent } from "../src/live.js";
import { startServer } from "../src/ui/server.js";
import type { IdeaDetail } from "../src/ui/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = [process.execPath, "--import", "tsx", join(ROOT, "src", "cli.ts")];
const FINAL = ["converged", "max_rounds", "stagnated", "stopped", "failed", "paused_quota"];

type Server = Awaited<ReturnType<typeof startServer>>;
const servers: Server[] = [];
const runsDirs: string[] = [];
after(async () => {
  // Kill any worker a failed test left behind, then stop the servers.
  for (const runsDir of runsDirs) {
    if (!existsSync(runsDir)) continue;
    for (const id of readdirSync(runsDir)) {
      try {
        process.kill(JSON.parse(readFileSync(join(runsDir, id, "worker.json"), "utf8")).pid, "SIGKILL");
      } catch { /* no worker */ }
    }
  }
  await Promise.all(servers.map((s) => s.close()));
});

function mockConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ideate-durability-"));
  const runsDir = join(dir, "runs");
  const cfgPath = join(dir, "config.json");
  const mock = { type: "mock", chunkDelayMs: 40 };
  writeFileSync(cfgPath, JSON.stringify({
    primary: "p", secondaries: ["a", "b"], loop: { maxRounds: 2 },
    providers: { p: mock, a: mock, b: mock }, runsDir,
  }));
  runsDirs.push(runsDir);
  return { cfgPath, runsDir };
}

async function serve(cfgPath: string) {
  const srv = await startServer({ cfgPath, port: 0, host: "127.0.0.1", cliCommand: CLI });
  servers.push(srv);
  const api = async (method: string, path: string, body?: unknown) => {
    // fetch sets Host to 127.0.0.1:<port> from the URL; writes carry a same-origin Origin like the app's.
    const headers: Record<string, string> = {};
    if (method !== "GET") headers.origin = srv.url;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(srv.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { srv, api };
}

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 60000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A minimal SSE client collecting `live` and `state` events, as the browser's EventSource would. */
function sse(url: string) {
  const live: { offset: number; event: LiveEvent }[] = [];
  const states: IdeaDetail[] = [];
  let buf = "";
  const req: ClientRequest = request(url, { headers: { host: new URL(url).host } }, (res) => {
    assert.equal(res.statusCode, 200, `SSE ${url}`);
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (type === "live") live.push(JSON.parse(data!));
        if (type === "state") states.push(JSON.parse(data!));
      }
    });
  });
  req.on("error", () => { /* closed by the test or the server */ });
  req.end();
  return { live, states, close: () => req.destroy() };
}

const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
const workerPid = (dir: string): number | undefined => {
  try { return JSON.parse(readFileSync(join(dir, "worker.json"), "utf8")).pid; } catch { return undefined; }
};
const transcript = (dir: string): { provider: string; role: string; round: number; output: string }[] =>
  readFileSync(join(dir, "raw", "transcript.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a run survives the tab closing and the server stopping, and replays with no gaps or duplicates", async () => {
  const { cfgPath, runsDir } = mockConfig();
  const one = await serve(cfgPath);
  const created = await one.api("POST", "/api/ideas", { brief: "Durable idea" });
  assert.equal(created.status, 201);
  const id: string = created.json.id;
  const dir = join(runsDir, id);

  // 1. The tab watches some text arrive, then closes.
  const tab = sse(`${one.srv.url}/api/ideas/${id}/live?from=0`);
  await waitFor(() => tab.live.filter((e) => e.event.t === "delta").length >= 5, "5 deltas");
  tab.close();

  // 2. `ideate ui` stops; the worker keeps running.
  await one.srv.close();
  await new Promise((r) => setTimeout(r, 300));
  const pid = workerPid(dir);
  assert.ok(pid, "worker.json names the worker");
  assert.ok(isAlive(pid), "worker still running after the server stopped");
  const writtenWhileDown = readLive(dir, 0).events.length;
  assert.ok(writtenWhileDown >= tab.live.length);

  // 3. A new server on another port; a new tab replays from the start until the run ends.
  const two = await serve(cfgPath);
  assert.notEqual(new URL(two.srv.url).port, new URL(one.srv.url).port);
  const again = sse(`${two.srv.url}/api/ideas/${id}/live?from=0`);
  await waitFor(() => {
    const last = again.states[again.states.length - 1];
    return last && FINAL.includes(last.state.status) && !last.summary.active;
  }, "a final state over SSE", 120000);
  const all = readLive(dir, 0);
  await waitFor(() => again.live.length >= all.events.length, "the replay to catch up");
  await new Promise((r) => setTimeout(r, 700)); // one more poll: nothing extra may arrive
  again.close();
  const final = again.states[again.states.length - 1]!;
  assert.ok(["converged", "max_rounds"].includes(final.state.status), final.state.status);
  assert.equal(isAlive(pid), false, "the worker exits when the run ends");

  // 4. Exactly the file's events, in order: no gaps, no duplicates; offsets match the file's.
  assert.deepEqual(again.live.map((e) => e.event), all.events);
  assert.deepEqual(again.live.map((e) => e.offset), all.ends);
  // What the first tab saw is a prefix of the same log.
  assert.deepEqual(tab.live.map((e) => e.event), all.events.slice(0, tab.live.length));

  // The text streamed for each call is exactly what the agent returned.
  const text = new Map<number, string>();
  const order: number[] = [];
  const meta = new Map<number, LiveEvent & { t: "call_start" }>();
  for (const { event: e } of again.live) {
    if (e.t === "call_start") meta.set(e.call, e);
    if (e.t === "delta") text.set(e.call, (text.get(e.call) ?? "") + e.text);
    if (e.t === "call_end") { assert.ok(e.ok, `call ${e.call} ok`); order.push(e.call); }
  }
  const calls = transcript(dir);
  assert.equal(order.length, calls.length, "one finished call per transcript entry");
  assert.ok(calls.length >= 3);
  calls.forEach((t, i) => {
    const call = order[i]!;
    const m = meta.get(call)!;
    assert.deepEqual([m.provider, m.role, m.round], [t.provider, t.role, t.round], `call ${call}`);
    assert.equal(text.get(call), t.output, `streamed text of call ${call} (${t.provider} ${t.role} r${t.round})`);
  });
});

test("a killed worker is shown interrupted, resumes, and keeps the killed call's partial text", async () => {
  const { cfgPath, runsDir } = mockConfig();
  const { api } = await serve(cfgPath);
  const id: string = (await api("POST", "/api/ideas", { brief: "Kill me mid-call" })).json.id;
  const dir = join(runsDir, id);

  // SIGKILL mid-call: the latest call has streamed at least two deltas and not ended.
  let killed!: LiveEvent & { t: "call_start" };
  const pid = await waitFor(() => {
    const p = workerPid(dir);
    if (!p) return undefined;
    const evs = readLive(dir, 0).events;
    const start = evs.filter((e) => e.t === "call_start").pop();
    if (!start || start.t !== "call_start" || evs.some((e) => e.t === "call_end" && e.call === start.call)) return undefined;
    if (evs.filter((e) => e.t === "delta" && e.call === start.call).length < 2) return undefined;
    killed = start;
    return p;
  }, "a call in progress");
  process.kill(pid, "SIGKILL");
  await waitFor(() => !isAlive(pid), "the worker to die");

  const partial = readLive(dir, 0).events.filter((e) => e.t === "delta" && e.call === killed.call);
  assert.ok(partial.length >= 2);
  await waitFor(async () => {
    const r = await api("GET", "/api/ideas");
    return r.json.find((row: { id: string; interrupted: boolean; active: boolean }) => row.id === id && row.interrupted && !row.active);
  }, `${id} listed as interrupted`);

  assert.equal((await api("POST", `/api/ideas/${id}/resume`)).status, 202);
  const done = await waitFor(async () => {
    const r = await api("GET", `/api/ideas/${id}`);
    const d: IdeaDetail | undefined = r.status === 200 ? r.json : undefined;
    return d && FINAL.includes(d.state.status) && !d.summary.active && d;
  }, "the resumed run to end", 120000);
  assert.ok(["converged", "max_rounds"].includes(done.state.status), done.state.status);

  // live.jsonl still holds the killed call's partial deltas, then a fresh call_start retrying that call.
  const evs = readLive(dir, 0).events;
  const killedStart = evs.findIndex((e) => e.t === "call_start" && e.call === killed.call);
  const kept = evs.filter((e) => e.t === "delta" && e.call === killed.call);
  assert.deepEqual(kept, partial, "partial deltas kept");
  assert.equal(evs.some((e) => e.t === "call_end" && e.call === killed.call), false, "the killed call never ended");
  let lastPartial = -1;
  evs.forEach((e, i) => { if (e.t === "delta" && e.call === killed.call) lastPartial = i; });
  const retry = evs.findIndex((e, i) => i > lastPartial && e.t === "call_start"
    && e.provider === killed.provider && e.role === killed.role && e.round === killed.round);
  assert.ok(killedStart >= 0 && retry > lastPartial, "a call_start for the retried call follows the partial text");
  const retried = evs[retry] as LiveEvent & { t: "call_start" };
  assert.ok(retried.call > killed.call, "the retry has a new call number");
  assert.ok(evs.some((e) => e.t === "call_end" && e.call === retried.call && e.ok), "the retry finished");
});

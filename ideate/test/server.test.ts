import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { request, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readInbox } from "../src/inbox.js";
import { readLive, type LiveEvent } from "../src/live.js";
import type { RunState } from "../src/store.js";
import { startServer } from "../src/ui/server.js";
import type { IdeaDetail } from "../src/ui/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = [process.execPath, "--import", "tsx", join(ROOT, "src", "cli.ts")];

const servers: { close(): Promise<void> }[] = [];
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

async function setup(mock: Record<string, unknown> = { chunkDelayMs: 5 }, maxRounds = 2) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-server-"));
  const runsDir = join(dir, "runs");
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    primary: "p", secondaries: ["a", "b"], loop: { maxRounds },
    providers: { p: { type: "mock", ...mock }, a: { type: "mock", ...mock }, b: { type: "mock", ...mock } },
    runsDir,
  }));
  runsDirs.push(runsDir);
  const srv = await startServer({ cfgPath, port: 0, host: "127.0.0.1", cliCommand: CLI });
  servers.push(srv);
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(srv.url + path, {
      method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, type: res.headers.get("content-type") ?? "" };
  };
  return { srv, runsDir, api };
}

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 20000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

type Api = Awaited<ReturnType<typeof setup>>["api"];
const detail = async (api: Api, id: string): Promise<IdeaDetail | undefined> => {
  const r = await api("GET", `/api/ideas/${id}`);
  return r.status === 200 ? r.json : undefined;
};
const ended = (api: Api, id: string) =>
  waitFor(async () => {
    const d = await detail(api, id);
    return d && d.state.status !== "running" && !d.summary.active && d;
  }, `run ${id} to end`);
const activeNow = (api: Api, id: string) =>
  waitFor(async () => (await detail(api, id))?.summary.active, `run ${id} to be active`);

/** A minimal SSE client collecting `live` and `state` events. */
function sse(url: string) {
  const live: { offset: number; event: LiveEvent }[] = [];
  const states: IdeaDetail[] = [];
  let buf = "";
  const req: ClientRequest = request(url, (res) => {
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
  req.on("error", () => { /* closed by the test */ });
  req.end();
  return { live, states, close: () => req.destroy() };
}

test("POST /api/ideas rejects empty brief", async () => {
  const { api, runsDir } = await setup();
  const r = await api("POST", "/api/ideas", { brief: "   " });
  assert.equal(r.status, 400);
  assert.ok(r.json.error);
  assert.equal(existsSync(runsDir) && readdirSync(runsDir).length > 0, false);
  assert.equal((await api("POST", "/api/ideas", { brief: "x", rounds: 0 })).status, 400);
  assert.equal((await api("GET", "/api/nope")).status, 404);
  assert.equal((await api("GET", "/api/ideas/missing")).status, 404);
});

test("GET /api/config returns primary, reviewers and max rounds", async () => {
  const { api } = await setup();
  const r = await api("GET", "/api/config");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { primary: "p", secondaries: ["a", "b"], maxRounds: 2 });
  assert.equal((await api("POST", "/api/config", {})).status, 404);
});

test("creates an idea and streams it to completion", async () => {
  const { api, srv, runsDir } = await setup();
  const created = await api("POST", "/api/ideas", { brief: "@not-a-file Offline sync", title: "Sync" });
  assert.equal(created.status, 201);
  const id: string = created.json.id;
  const d = await ended(api, id);
  assert.ok(["converged", "max_rounds"].includes(d.state.status), d.state.status);
  assert.equal(d.state.brief, "@not-a-file Offline sync");
  assert.equal(d.state.title, "Sync");
  assert.equal(d.maxRounds, 2);
  assert.equal(d.messages[0]!.kind, "brief");
  assert.equal(d.messages[d.messages.length - 1]!.kind, "end");
  assert.ok((await api("GET", "/api/ideas")).json.some((r: { id: string }) => r.id === id));

  const total = readLive(join(runsDir, id), 0).events.length;
  const c = sse(`${srv.url}/api/ideas/${id}/live?from=0`);
  await waitFor(() => c.live.length >= total && c.states.length >= 1, "SSE replay");
  c.close();
  const transcript = readFileSync(join(runsDir, id, "raw", "transcript.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const starts = c.live.map((e) => e.event).filter((e) => e.t === "call_start");
  const ends = new Set(c.live.map((e) => e.event).filter((e) => e.t === "call_end").map((e) => e.call));
  for (const t of transcript) {
    const hit = starts.find((s) => s.t === "call_start" && s.provider === t.provider && s.role === t.role && s.round === t.round);
    assert.ok(hit, `call_start for ${t.provider} ${t.role} r${t.round}`);
    assert.ok(ends.has(hit.call), `call_end for call ${hit.call}`);
  }

  const report = await api("GET", `/api/ideas/${id}/report`);
  assert.equal(report.status, 200);
  assert.match(report.type, /text\/markdown/);
  assert.match(report.text, /^# Sync/);
});

test("live replay resumes from offset without duplicates", async () => {
  const { api, srv, runsDir } = await setup({ chunkDelayMs: 20 });
  const id: string = (await api("POST", "/api/ideas", { brief: "Replay me" })).json.id;
  // Opened right away, before the worker has written state.json: the stream waits for it.
  const first = sse(`${srv.url}/api/ideas/${id}/live?from=0`);
  await waitFor(() => first.live.length >= 3, "3 live events");
  first.close();
  const got = first.live.slice();
  // Offsets are per event and increasing, so a client can resume from any of them.
  for (let i = 1; i < got.length; i++) assert.ok(got[i]!.offset > got[i - 1]!.offset);
  const from = got[got.length - 1]!.offset;

  await ended(api, id);
  const all = readLive(join(runsDir, id), 0).events;
  const second = sse(`${srv.url}/api/ideas/${id}/live?from=${from}`);
  await waitFor(() => got.length + second.live.length >= all.length, "rest of the events");
  await new Promise((r) => setTimeout(r, 600)); // one more poll: nothing extra may arrive
  second.close();
  assert.deepEqual([...got, ...second.live].map((e) => e.event), all);
});

test("state poll survives an unreadable state.json", async () => {
  const { api, srv, runsDir } = await setup();
  const id = "old-run";
  mkdirSync(join(runsDir, id), { recursive: true });
  const statePath = join(runsDir, id, "state.json");
  const state: RunState = {
    id, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "max_rounds",
    brief: "Old brief", primary: "p", secondaries: ["a", "b"], rounds: [],
  };
  writeFileSync(statePath, JSON.stringify(state));
  const c = sse(`${srv.url}/api/ideas/${id}/live?from=0`);
  await waitFor(() => c.states.length === 1, "initial state event");
  assert.equal(c.states[0]!.state.brief, "Old brief");

  writeFileSync(statePath, "{");
  await new Promise((r) => setTimeout(r, 700)); // let the poll see the broken file
  assert.equal((await api("GET", "/api/ideas")).status, 200);
  assert.equal(c.states.length, 1, "no state event for a broken file");

  writeFileSync(statePath, JSON.stringify({ ...state, title: "Restored" }));
  await waitFor(() => c.states.length === 2, "state event after restore");
  c.close();
  assert.equal(c.states[1]!.state.title, "Restored");
});

test("maxRounds never reads below the rounds a legacy run already has", async () => {
  const { api, runsDir } = await setup({ chunkDelayMs: 5 }, 2);
  const write = (id: string, extra: Partial<RunState>) => {
    mkdirSync(join(runsDir, id), { recursive: true });
    const rounds = [1, 2, 3].map((round) => ({ round, proposal: `P${round}`, reviews: {} }));
    writeFileSync(join(runsDir, id, "state.json"), JSON.stringify({
      id, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "max_rounds",
      brief: "Old", primary: "p", secondaries: ["a", "b"], rounds, ...extra,
    }));
  };
  write("legacy-run", {});
  assert.equal((await api("GET", "/api/ideas/legacy-run")).json.maxRounds, 3);
  write("set-run", { maxRounds: 6 });
  assert.equal((await api("GET", "/api/ideas/set-run")).json.maxRounds, 6);
});

test("messages go to the inbox while active and start a continue when idle", async () => {
  const { api, runsDir } = await setup({ chunkDelayMs: 50 });
  const id: string = (await api("POST", "/api/ideas", { brief: "Inbox me" })).json.id;
  await activeNow(api, id);
  assert.equal((await api("POST", `/api/ideas/${id}/messages`, { note: "  " })).status, 400);
  const queued = await api("POST", `/api/ideas/${id}/messages`, { note: "First note", more: 1 });
  assert.equal(queued.status, 202);
  const items = readInbox(join(runsDir, id), 0).items;
  assert.deepEqual(items.map((i) => i.type), ["note", "more"]);
  assert.equal(new Set(items.map((i) => i.ts)).size, 2, "unique ts");
  await ended(api, id);

  const before = readFileSync(join(runsDir, id, "raw", "transcript.jsonl"), "utf8");
  const sent = await api("POST", `/api/ideas/${id}/messages`, { note: "Second note", more: 1 });
  assert.equal(sent.status, 202);
  await waitFor(() => existsSync(join(runsDir, id, "worker.json")) || readFileSync(join(runsDir, id, "raw", "transcript.jsonl"), "utf8") !== before, "a continue worker");
  await waitFor(() => readFileSync(join(runsDir, id, "raw", "transcript.jsonl"), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l)).some((t) => t.role === "revise" && t.prompt.includes("Second note")), "note in a revise prompt");
  const d = await ended(api, id);
  assert.ok(d.messages.some((m) => m.kind === "owner" && m.owner?.note?.includes("Second note")));
  assert.equal(readFileSync(join(runsDir, id, "worker.log"), "utf8").includes("Error:"), false);
});

test("stop and resume", async () => {
  const { api } = await setup({ chunkDelayMs: 100 });
  const id: string = (await api("POST", "/api/ideas", { brief: "Stop me" })).json.id;
  await activeNow(api, id);
  assert.equal((await api("PATCH", `/api/ideas/${id}`, { title: "Busy" })).status, 409);
  assert.equal((await api("POST", `/api/ideas/${id}/stop`)).status, 202);
  const stopped = await ended(api, id);
  assert.equal(stopped.state.status, "stopped");
  assert.equal(stopped.state.statusDetail, "Stopped from the app");
  assert.equal((await api("POST", `/api/ideas/${id}/stop`)).status, 409);

  assert.equal((await api("PATCH", `/api/ideas/${id}`, { title: "Renamed" })).status, 200);
  assert.equal((await detail(api, id))!.state.title, "Renamed");

  assert.equal((await api("POST", `/api/ideas/${id}/resume`)).status, 202);
  assert.equal((await api("POST", `/api/ideas/${id}/resume`)).status, 409);
  const done = await ended(api, id);
  assert.ok(["converged", "max_rounds"].includes(done.state.status), done.state.status);
});

test("a second stop right after the first doesn't signal the worker again", async () => {
  const { api, runsDir } = await setup();
  const dir = join(runsDir, "busy");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    id: "busy", createdAt: now, updatedAt: now, status: "running", brief: "b", primary: "p", secondaries: ["a", "b"], rounds: [],
  }));
  // A stand-in worker that counts the SIGTERMs it gets.
  const hits = join(dir, "terms");
  const child = spawn("sh", ["-c", `trap 'echo T >> "${hits}"' TERM; while :; do sleep 0.05; done`], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 200)); // the trap is installed
    writeFileSync(join(dir, "worker.json"), JSON.stringify({ pid: child.pid, startedAt: now, heartbeatAt: new Date().toISOString(), command: ["x"] }));
    assert.equal((await api("POST", "/api/ideas/busy/stop")).status, 202);
    await new Promise((r) => setTimeout(r, 300)); // a separate click, not a coalesced signal
    assert.equal((await api("POST", "/api/ideas/busy/stop")).status, 202);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(readFileSync(hits, "utf8"), "T\n");
  } finally {
    child.kill("SIGKILL");
  }
});

test("a new idea whose worker dies before writing state.json reports the worker's error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ideate-server-"));
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    primary: "p", secondaries: ["a"], providers: { p: { type: "mock" }, a: { type: "mock" } }, runsDir: join(dir, "runs"),
  }));
  const failing = [process.execPath, "-e", "console.error('boom: the agent CLI is not installed'); process.exit(1)"];
  const srv = await startServer({ cfgPath, port: 0, host: "127.0.0.1", cliCommand: failing });
  servers.push(srv);
  const res = await fetch(`${srv.url}/api/ideas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: "x" }) });
  const { id } = await res.json() as { id: string };
  // An SSE stream opened while it was starting gets a `failed` event instead of waiting forever.
  const failedEvent = new Promise<string>((resolve) => {
    const req = request(`${srv.url}/api/ideas/${id}/live`, (r) => {
      let buf = "";
      r.on("data", (d) => { buf += d; });
      r.on("end", () => resolve(buf));
    });
    req.on("error", () => resolve(""));
    req.end();
  });
  const err = await waitFor(async () => {
    const r = await fetch(`${srv.url}/api/ideas/${id}`);
    return r.status !== 503 && { status: r.status, body: await r.json() as { error: string } };
  }, "the failed start to be reported");
  assert.ok(err.status >= 400, String(err.status));
  assert.match(err.body.error, /boom: the agent CLI is not installed/);
  assert.match(await failedEvent, /event: failed\ndata: .*boom: the agent CLI is not installed/);
});

/** Starts an idea and SIGKILLs its worker once `when` holds for live.jsonl; returns the idea once interrupted. */
async function interrupted(api: Api, runsDir: string, when: (events: LiveEvent[]) => boolean) {
  const id: string = (await api("POST", "/api/ideas", { brief: "Kill me" })).json.id;
  const dir = join(runsDir, id);
  const pid = await waitFor(() => {
    if (!existsSync(join(dir, "worker.json")) || !when(readLive(dir, 0).events)) return undefined;
    return JSON.parse(readFileSync(join(dir, "worker.json"), "utf8")).pid as number;
  }, "the moment to kill the worker");
  process.kill(pid, "SIGKILL");
  const d = await waitFor(async () => (await detail(api, id))?.summary.interrupted && detail(api, id), `${id} interrupted`);
  return { id, dir, before: d! };
}
const workerCommand = (dir: string): string[] | undefined => {
  try { return JSON.parse(readFileSync(join(dir, "worker.json"), "utf8")).command; } catch { return undefined; }
};
const revisePrompts = (dir: string): { round: number; prompt: string }[] =>
  readFileSync(join(dir, "raw", "transcript.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.role === "revise");

test("a message to an idea interrupted before its first round resumes it and is used", async () => {
  const { api, runsDir } = await setup({ chunkDelayMs: 60 });
  const { id, dir, before } = await interrupted(api, runsDir, (evs) => evs.some((e) => e.t === "call_start" && e.role === "generate"));
  assert.equal(before.state.rounds.length, 0);
  const r = await api("POST", `/api/ideas/${id}/messages`, { note: "Mind the battery" });
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { queued: true, resumed: true });
  assert.deepEqual(readInbox(dir, 0).items.map((i) => i.type === "note" && i.text), ["Mind the battery"]);
  // worker.json first still names the killed `run`; the new worker replaces it.
  await waitFor(() => workerCommand(dir)?.includes("resume"), "a `resume` worker");
  const done = await ended(api, id);
  assert.ok(["converged", "max_rounds"].includes(done.state.status), done.state.status);
  assert.doesNotMatch(readFileSync(join(dir, "worker.log"), "utf8"), /no rounds/);
  const revise = revisePrompts(dir).find((e) => e.round === 1);
  assert.match(revise!.prompt, /Mind the battery/);
});

test("a message to an idea interrupted mid-round resumes it with its round budget", async () => {
  const { api, runsDir } = await setup({ chunkDelayMs: 60 });
  const { id, dir, before } = await interrupted(api, runsDir, (evs) => evs.some((e) => e.t === "call_start" && e.role === "review"));
  assert.equal(before.state.rounds.length, 1);
  const budget = before.state.maxRounds;
  const r = await api("POST", `/api/ideas/${id}/messages`, { note: "Think about cost" });
  assert.deepEqual([r.status, r.json], [202, { queued: true, resumed: true }]);
  const done = await ended(api, id);
  assert.equal(done.state.maxRounds, budget);
  assert.match(done.state.rounds[0]!.humanFeedback ?? "", /Think about cost/);
  assert.match(revisePrompts(dir).find((e) => e.round === 1)!.prompt, /Think about cost/);
  // A bad ref is still refused before anything is queued or started.
  const bad = await api("POST", `/api/ideas/${id}/messages`, { reopen: ["r9:x:NOPE"] });
  assert.equal(bad.status, 400);
});

/** A raw request, so Host and Origin can be set (fetch won't set Host). */
function raw(url: string, method: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request(url, { method, headers }, (res) => { res.resume(); res.on("end", () => ok(res.statusCode!)); });
    req.on("error", fail);
    req.end(body);
  });
}

test("rejects cross-site and DNS-rebinding requests", async () => {
  const { srv, runsDir, api } = await setup();
  const port = new URL(srv.url).port;
  const json = { "content-type": "application/json" };
  const brief = JSON.stringify({ brief: "Spend my quota" });
  assert.equal(await raw(`${srv.url}/api/ideas`, "GET", { host: `evil.example:${port}` }), 403);
  assert.equal(await raw(`${srv.url}/`, "GET", { host: `evil.example:${port}` }), 403);
  assert.equal(await raw(`${srv.url}/api/ideas`, "GET", { host: `localhost:${port}` }), 200);
  assert.equal(await raw(`${srv.url}/api/ideas`, "POST", { ...json, origin: "https://evil.example" }, brief), 403);
  assert.equal(await raw(`${srv.url}/api/ideas`, "POST", { "content-type": "text/plain", origin: srv.url }, brief), 415);
  assert.equal(await raw(`${srv.url}/api/ideas`, "POST", { "content-type": "text/plain" }, brief), 415);
  assert.equal(existsSync(runsDir) && readdirSync(runsDir).length > 0, false, "nothing spawned");
  // Same-origin writes (as the built app and the Vite proxy send them) are allowed.
  assert.equal(await raw(`${srv.url}/api/ideas`, "POST", { ...json, origin: `http://localhost:${port}` }, JSON.stringify({ brief: " " })), 400);
  const ok = await api("POST", "/api/ideas", { brief: "Allowed" });
  assert.equal(ok.status, 201);
  await ended(api, ok.json.id);
});

test("branch starts a new idea from a round", async () => {
  const { api } = await setup({ chunkDelayMs: 5 }, 1);
  const id: string = (await api("POST", "/api/ideas", { brief: "Branch me" })).json.id;
  await ended(api, id);
  assert.equal((await api("POST", `/api/ideas/${id}/branch`, { fromRound: 9 })).status, 400);
  const br = await api("POST", `/api/ideas/${id}/branch`, { fromRound: 1, note: "Other way", more: 1 });
  assert.equal(br.status, 201);
  const d = await ended(api, br.json.id);
  assert.deepEqual(d.state.parent, { id, fromRound: 1 });
});

test("serves the built UI, or a hint page when it isn't built, and nothing outside it", async () => {
  const { srv } = await setup();
  const res = await fetch(`${srv.url}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, existsSync(join(ROOT, "dist", "web", "index.html")) ? /<div id="root">/ : /Run npm run build/);
  const esc = await fetch(`${srv.url}/..%2f..%2fpackage.json`);
  assert.doesNotMatch(await esc.text(), /"name": "ideation-loop"/);
});

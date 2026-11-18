import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../src/config.js";
import { LiveLog, readLive } from "../src/live.js";
import { buildProviders, StopError } from "../src/providers.js";
import { config, runLoop, transcript } from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "live-test-"));

test("loop writes call_start, deltas and call_end for every call", async () => {
  const cfg = config({ maxRounds: 2 });
  for (const p of Object.values(cfg.providers)) if (p.type === "mock") p.chunkDelayMs = 1;
  const providers = buildProviders(cfg.providers, ["p", "a", "b"], 30);
  const run = runLoop(cfg, providers);
  await run.done;
  const { events } = readLive(run.store.dir, 0);
  const calls = transcript(run.store);
  const raw = readFileSync(join(run.store.dir, "raw", "transcript.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { output: string });
  assert.equal(events.filter((e) => e.t === "call_start").length, calls.length);
  assert.equal(events.filter((e) => e.t === "call_end").length, calls.length);
  raw.forEach((entry, i) => {
    const text = events.flatMap((e) => (e.t === "delta" && e.call === i + 1 ? [e.text] : [])).join("");
    assert.equal(text, entry.output);
  });
});

test("call ids continue across LiveLog instances", () => {
  const dir = tmp();
  assert.equal(new LiveLog(dir).start({ provider: "p", role: "generate", round: 1 }), 1);
  assert.equal(new LiveLog(dir).start({ provider: "p", role: "review", round: 1 }), 2);
});

test("readLive ignores a partial trailing line", () => {
  const dir = tmp();
  const f = join(dir, "live.jsonl");
  const full = JSON.stringify({ t: "delta", call: 1, text: "a" }) + "\n" + JSON.stringify({ t: "delta", call: 1, text: "é" }) + "\n";
  writeFileSync(f, full + '{"t":"delta","ca');
  const r = readLive(dir, 0);
  assert.equal(r.events.length, 2);
  assert.equal(r.offset, Buffer.byteLength(full));
  appendFileSync(f, 'll":1,"text":"b"}\n');
  const r2 = readLive(dir, r.offset);
  assert.equal(r2.events.length, 1);
});

test("abort stops a slow mock call with StopError", async () => {
  const cfg = Config.parse({
    primary: "p", secondaries: ["a"], runsDir: tmp(),
    providers: { p: { type: "mock", chunkDelayMs: 50 }, a: { type: "mock" } },
  });
  const p = buildProviders(cfg.providers, ["p"], 30).get("p")!;
  const ac = new AbortController();
  const got: string[] = [];
  setTimeout(() => ac.abort(), 120);
  await assert.rejects(p.complete("x", "generate", { onDelta: (t) => got.push(t), signal: ac.signal }), StopError);
  assert.ok(got.length >= 1);
});

test("command provider streams deltas before exit", async () => {
  const script =
    'printf "{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"text_delta\\":\\"a\\"}}\\n"; sleep 0.3; ' +
    'printf "{\\"event\\":\\"result\\",\\"result\\":{\\"status\\":\\"SUCCESS\\",\\"response\\":\\"a\\"}}\\n"';
  const cfg = Config.parse({
    primary: "p", secondaries: ["a"], runsDir: tmp(),
    providers: { p: { type: "command", cmd: "sh", args: ["-c", script], stream: "agy-stream-json" }, a: { type: "mock" } },
  });
  const p = buildProviders(cfg.providers, ["p"], 30).get("p")!;
  let resolved = false;
  const got: string[] = [];
  const done = p.complete("x", "generate", { onDelta: (t) => { got.push(t); assert.equal(resolved, false); } }).then(() => { resolved = true; });
  await done;
  assert.deepEqual(got, ["a"]);
});

test("readLive skips a torn line and LiveLog appends on a fresh line after it", () => {
  const dir = tmp();
  const f = join(dir, "live.jsonl");
  writeFileSync(f, JSON.stringify({ t: "delta", call: 1, text: "a" }) + "\n" + '{"t":"delta","call":1,"te');
  const call = new LiveLog(dir).start({ provider: "p", role: "review", round: 1 });
  const r = readLive(dir, 0);
  assert.deepEqual(r.events.map((e) => e.t), ["delta", "call_start"]);
  assert.equal((r.events[1] as { call: number }).call, call);
  assert.equal(r.offset, readFileSync(f).length);
  // A complete garbage line in the middle doesn't make the log unreadable either.
  appendFileSync(f, "not json\n" + JSON.stringify({ t: "delta", call, text: "b" }) + "\n");
  assert.deepEqual(readLive(dir, r.offset).events.map((e) => e.t), ["delta"]);
});

test("readLive gives the byte offset after each event", () => {
  const dir = mkdtempSync(join(tmpdir(), "ideate-live-"));
  const a = JSON.stringify({ t: "delta", call: 1, text: "héllo ✓" }) + "\n";
  const b = JSON.stringify({ t: "delta", call: 1, text: "x" }) + "\n";
  writeFileSync(join(dir, "live.jsonl"), a + "not json\n" + b);
  const all = readLive(dir, 0);
  const la = Buffer.byteLength(a);
  assert.deepEqual(all.ends, [la, la + 9 + Buffer.byteLength(b)]);
  assert.equal(all.offset, all.ends[1]);
  const rest = readLive(dir, all.ends[0]!);
  assert.deepEqual(rest.events, [all.events[1]]);
});

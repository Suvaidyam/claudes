import assert from "node:assert/strict";
import { test } from "node:test";
import { envelopeError, extractJson, extractText } from "../src/json.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProviders, QuotaError, StopError, waitForChildren } from "../src/providers.js";

const sh = (script: string, extra: { input?: "stdin" | "arg"; timeoutSec?: number } = {}) =>
  ({ type: "command" as const, cmd: "sh", args: ["-c", script], input: extra.input ?? "stdin", timeoutSec: extra.timeoutSec });
const provider = (cfg: ReturnType<typeof sh>) => buildProviders({ x: cfg }, ["x"], 10).get("x")!;

test("extractJson finds JSON in prose, fences and envelopes", () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('prefix {"a": {"b": "}"}} suffix'), { a: { b: "}" } });
  assert.deepEqual(extractJson(JSON.stringify({ type: "result", result: '{"a": 2}' })), { a: 2 });
  const withFence = { proposal: "## API\n```json\n{\"id\": 1}\n```", dispositions: [] };
  assert.deepEqual(extractJson("```json\n" + JSON.stringify(withFence) + "\n```"), withFence);
  assert.throws(() => extractJson("no json here"));
  assert.equal(extractText(JSON.stringify({ result: "hello" })), "hello");
});

test("envelopeError detects errors reported with exit code 0", () => {
  assert.match(envelopeError('{"is_error":true,"api_error_status":429,"result":"usage limit reached"}')!, /429.*usage limit/);
  assert.match(envelopeError('{"subtype":"error_max_turns","is_error":false}')!, /error_max_turns/);
  assert.match(envelopeError('{"error":{"message":"denied"}}')!, /denied/);
  assert.equal(envelopeError('{"is_error":false,"api_error_status":null,"subtype":"success","result":"ok"}'), undefined);
  assert.equal(envelopeError('{"response":"ok","error":null}'), undefined);
  assert.equal(envelopeError("# plain markdown {x}"), undefined);
});

test("command provider: in-band quota error with exit 0 raises QuotaError", async () => {
  const p = provider(sh(`echo '{"is_error":true,"result":"Claude AI usage limit reached"}'`));
  await assert.rejects(p.complete("x", "review"), QuotaError);
});

test("command provider: a CLI that exits without reading stdin fails cleanly, not with EPIPE", async () => {
  const p = provider(sh("exit 3"));
  await assert.rejects(p.complete("x".repeat(2_000_000), "review"), /exit 3/);
});

test("command provider: refuses oversized argument prompts", async () => {
  const p = provider({ ...sh('echo "$0"', { input: "arg" }), args: ["-c", "echo ok", "{prompt}"] });
  assert.equal((await p.complete("short", "review")).trim(), "ok");
  await assert.rejects(p.complete("x".repeat(200_000), "review"), /too long to pass as an argument/);
});

test("command provider: times out", async () => {
  const p = provider(sh("sleep 5", { timeoutSec: 0.3 }));
  await assert.rejects(p.complete("x", "review"), /timed out/);
});

test("agy stream-json: result event is unwrapped, and errors or empty responses are detected", () => {
  const stream = (result: object) => [
    '{"event":"init","init":{"cwd":"/tmp/x"}}',
    '{"event":"step_update","step_update":{"text_delta":"{"}}',
    JSON.stringify({ event: "result", result }),
  ].join("\n");
  const ok = stream({ status: "SUCCESS", response: 'Sure:\n{"score": 7}' });
  assert.equal(envelopeError(ok), undefined);
  assert.equal(extractText(ok), 'Sure:\n{"score": 7}');
  assert.deepEqual(extractJson(ok), { score: 7 });

  assert.match(envelopeError(stream({ status: "SUCCESS", response: "", denied_actions: [{ display_name: "ReadFile" }] }))!,
    /empty response — denied tools: ReadFile/);
  assert.match(envelopeError(stream({ status: "ERROR", response: "", error: "bad input" }))!, /status ERROR.*bad input/);
  assert.match(envelopeError(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "  " }))!, /empty response/);
});

test("command provider: stream-json input sends one JSON message line on stdin", async () => {
  const p = provider({ ...sh("cat"), input: "stream-json" } as unknown as ReturnType<typeof sh>);
  const out = await p.complete('line 1\nline "2"', "review");
  assert.equal(out.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(out), { event: "user", message: { content: 'line 1\nline "2"' } });
});

test("command provider: no deltas are delivered after a timeout rejects", async () => {
  // The child ignores SIGTERM and prints a delta after the timeout, then exits.
  const script =
    'trap "" TERM; sleep 0.6; ' +
    'printf "{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"text_delta\\":\\"late\\"}}\\n"';
  const p = provider({ ...sh(script, { timeoutSec: 0.2 }), stream: "agy-stream-json" } as unknown as ReturnType<typeof sh>);
  let rejected = false;
  const got: string[] = [];
  await assert.rejects(p.complete("x", "generate", { onDelta: (t) => got.push(t) }), /timed out/).then(() => { rejected = true; });
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(rejected);
  assert.deepEqual(got, []);
});

test("command provider: after a stop, waitForChildren kills a CLI that ignores SIGTERM", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "ideate-prov-")), "pid");
  const p = provider(sh(`echo $$ > "${pidFile}"; trap "" TERM; while :; do sleep 0.1; done`));
  const ac = new AbortController();
  const call = p.complete("x", "review", { signal: ac.signal });
  let pid = 0;
  for (let i = 0; i < 100 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 20));
    try { pid = Number(readFileSync(pidFile, "utf8").trim()); } catch { /* not yet */ }
  }
  assert.ok(pid > 0, "the CLI started");
  await new Promise((r) => setTimeout(r, 100)); // its trap is installed
  ac.abort();
  await assert.rejects(call, StopError);
  const grace = 300;
  const t0 = Date.now();
  await waitForChildren(grace);
  assert.ok(Date.now() - t0 < grace + 1000, `took ${Date.now() - t0} ms`);
  assert.throws(() => process.kill(pid, 0), "the CLI is gone");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { envelopeError, extractText } from "../src/json.js";
import { createStreamParser, type StreamFormat } from "../src/streams.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}-stream.jsonl`, import.meta.url), "utf8");

function deltas(format: StreamFormat, raw: string, size = raw.length): string[] {
  const parser = createStreamParser(format);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += size) out.push(...parser.push(raw.slice(i, i + size)));
  out.push(...parser.flush());
  return out;
}

test("claude parser yields only text deltas", () => {
  assert.equal(deltas("claude-stream-json", fixture("claude"), 7).join(""), "1\n2\n3\n4\n5");
});

test("codex parser yields the agent message", () => {
  assert.equal(deltas("codex-json", fixture("codex")).join(""), "1\n2\n3\n4\n5");
});

test("agy parser yields text deltas", () => {
  const raw = fixture("agy");
  const last = raw.trim().split("\n").at(-1)!;
  const response = (JSON.parse(last) as { result: { response: string } }).result.response;
  assert.equal(deltas("agy-stream-json", raw, 11).join(""), response);
});

test("parsers ignore non-JSON lines", () => {
  for (const f of ["claude-stream-json", "codex-json", "agy-stream-json"] as const) {
    assert.deepEqual(createStreamParser(f).push("garbage\n"), []);
  }
});

test("extractText unwraps claude and codex streams", () => {
  for (const name of ["claude", "codex"]) {
    assert.equal(extractText(fixture(name)), "1\n2\n3\n4\n5");
    assert.equal(envelopeError(fixture(name)), undefined);
  }
});

test("envelopeError catches codex failures", () => {
  const raw = fixture("codex").trim().split("\n").slice(0, 2).join("\n") +
    '\n{"type":"turn.failed","error":{"message":"usage limit reached"}}\n';
  assert.match(envelopeError(raw) ?? "", /usage limit/);
});

test("envelopeError catches claude stream errors", () => {
  const lines = fixture("claude").trim().split("\n");
  lines[lines.length - 1] = '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Overloaded"}';
  assert.match(envelopeError(lines.join("\n")) ?? "", /Overloaded/);
});

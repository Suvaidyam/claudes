import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPartialProposal } from "./partialProposal";

test("extractPartialProposal decodes the proposal string streamed so far", () => {
  assert.equal(extractPartialProposal('{"proposal": "## A\\nline'), "## A\nline");
  assert.equal(extractPartialProposal('{"proposal":"x\\'), "x");
  assert.equal(extractPartialProposal('{"dispositions":[],"proposal":"a\\"b"'), 'a"b');
  assert.equal(extractPartialProposal('{"propo'), undefined);
  assert.equal(extractPartialProposal('{"proposal":"\\u00e9"'), "é");
});

test("extractPartialProposal handles backslashes, partial escapes and surrounding text", () => {
  assert.equal(extractPartialProposal('{"proposal":"a\\\\b'), "a\\b");
  assert.equal(extractPartialProposal('{"proposal":"x\\u00'), "x");
  assert.equal(extractPartialProposal('Sure:\n```json\n{"proposal":"ok'), "ok");
  assert.equal(extractPartialProposal('{"proposal":'), undefined);
  assert.equal(extractPartialProposal('{"proposal":"'), "");
});

test("extractPartialProposal only reads the top-level key", () => {
  // A nested "proposal" key or a string value "proposal" is not the answer.
  assert.equal(extractPartialProposal('{"dispositions":[{"proposal":"no"}],"note":"proposal","proposal":"yes'), "yes");
  assert.equal(extractPartialProposal('{"dispositions":[{"proposal":"no"'), undefined);
});

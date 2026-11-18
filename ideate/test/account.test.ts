/** A plain terminal picks up the pool's current account when CLAUDE_CONFIG_DIR is unset. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { poolConfigDir } from "../src/account.js";

function base(current: string | undefined, accounts: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "ideate-account-"));
  if (current !== undefined) writeFileSync(join(dir, "current_profile"), current);
  if (accounts !== undefined) writeFileSync(join(dir, "accounts.json"), accounts);
  return dir;
}
const list = (a: object) => JSON.stringify({ accounts: [a] });
/** A config folder that exists. */
const folder = (name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), "ideate-account-dir-")), name);
  mkdirSync(dir);
  return dir;
};
const work = folder("work");
const legacy = folder("legacy");

test("returns the current account's config_path", () => {
  const b = base("work\n", list({ name: "work", config_path: work }));
  assert.equal(poolConfigDir({ CLAUDES_BASE: b }), work);
});

test("falls back to path when config_path is absent", () => {
  const b = base("work\n", list({ name: "work", path: legacy }));
  assert.equal(poolConfigDir({ CLAUDES_BASE: b }), legacy);
});

test("an already-set CLAUDE_CONFIG_DIR wins", () => {
  const b = base("work\n", list({ name: "work", config_path: work }));
  assert.equal(poolConfigDir({ CLAUDES_BASE: b, CLAUDE_CONFIG_DIR: "/already" }), undefined);
});

test("an unknown current account yields undefined", () => {
  const b = base("ghost\n", list({ name: "work", config_path: work }));
  assert.equal(poolConfigDir({ CLAUDES_BASE: b }), undefined);
});

test("unparseable accounts.json yields undefined without throwing", () => {
  const b = base("work\n", "not json");
  assert.equal(poolConfigDir({ CLAUDES_BASE: b }), undefined);
});

test("no current_profile yields undefined", () => {
  const b = base(undefined, list({ name: "work", config_path: work }));
  assert.equal(poolConfigDir({ CLAUDES_BASE: b }), undefined);
});

test("an account with no path yields undefined", () => {
  const b = base("work\n", list({ name: "work" }));
  assert.equal(poolConfigDir({ CLAUDES_BASE: b }), undefined);
});

test("an account whose config folder is missing yields undefined", () => {
  const b = base("work\n", list({ name: "work", config_path: join(work, "gone") }));
  assert.equal(poolConfigDir({ CLAUDES_BASE: b }), undefined);
});

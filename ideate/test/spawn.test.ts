/** defaultCliCommand: how the app launches CLI workers from source, dist/ and the bundle. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultCliCommand } from "../src/ui/spawn.js";

test("from the bundle, workers run the bundle file itself", () => {
  assert.deepEqual(defaultCliCommand("file:///a/b/bin/ideate.mjs"), [process.execPath, "/a/b/bin/ideate.mjs"]);
});

test("from source under tsx, workers run src/cli.ts through tsx", () => {
  assert.deepEqual(defaultCliCommand("file:///a/b/src/ui/spawn.ts"), [process.execPath, "--import", "tsx", "/a/b/src/cli.ts"]);
});

test("from dist/, workers run dist/cli.js", () => {
  assert.deepEqual(defaultCliCommand("file:///a/b/dist/ui/spawn.js"), [process.execPath, "/a/b/dist/cli.js"]);
});

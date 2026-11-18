/**
 * Starting CLI workers from the app. Each is a detached process with its output appended to
 * runs/<id>/worker.log, so it keeps running when `ideate ui` or the browser goes away.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How to launch the CLI from this module: bundled, `node bin/ideate.mjs` (this very file);
 * compiled, `node dist/cli.js`; from src/ under tsx, `node --import tsx src/cli.ts`.
 * Resolved from this file, never from process.argv[1].
 */
export function defaultCliCommand(moduleUrl = import.meta.url): string[] {
  const file = fileURLToPath(moduleUrl);
  if (basename(file) === "ideate.mjs") return [process.execPath, file];
  const root = fileURLToPath(new URL("../../", moduleUrl)); // dist/ui/ or src/ui/ → repo root
  return moduleUrl.endsWith(".ts")
    ? [process.execPath, "--import", "tsx", join(root, "src", "cli.ts")]
    : [process.execPath, join(root, "dist", "cli.js")];
}

/**
 * Starts `<cliCommand> <args> --worker --config <cfgPath>` detached; returns its pid. `onExit`
 * fires when it exits (while this process is still running), so its pid is never trusted after.
 */
export function spawnWorker(cliCommand: string[], cfgPath: string, args: string[], runDir: string, onExit?: () => void): number {
  const [cmd, ...pre] = cliCommand;
  if (!cmd) throw new Error("Empty CLI command");
  mkdirSync(runDir, { recursive: true });
  const logFd = openSync(join(runDir, "worker.log"), "a");
  try {
    const child = spawn(cmd, [...pre, ...args, "--worker", "--config", cfgPath], {
      cwd: process.cwd(), detached: true, stdio: ["ignore", logFd, logFd],
    });
    child.on("error", () => { /* reported through the missing pid below */ });
    if (onExit) child.once("exit", onExit);
    if (child.pid === undefined) throw new Error(`Could not start ${cmd}`);
    child.unref();
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The claudes base folder: CLAUDES_BASE, else ~/.claudes. */
export function claudesBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDES_BASE ? env.CLAUDES_BASE : join(homedir(), ".claudes");
}

/** Where config.json and runs/ live: IDEATE_HOME (a leading ~/ expanded), else <base>/shared/ideate. */
export function ideateHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.IDEATE_HOME;
  if (h) return h.startsWith("~/") ? join(homedir(), h.slice(2)) : h;
  return join(claudesBase(env), "shared", "ideate");
}

/** config.example.json sits one level above src/, dist/ and the bundle's bin/. */
export function exampleConfigPath(): string {
  return fileURLToPath(new URL("../config.example.json", import.meta.url));
}

/** An explicit --config must exist; otherwise <home>/config.json, seeded from the example when missing. */
export function resolveConfigPath(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): { path: string; created: boolean } {
  if (flag !== undefined) {
    const path = resolve(flag);
    if (!existsSync(path)) throw new Error(`Config not found: ${path}`);
    return { path, created: false };
  }
  const home = resolve(ideateHome(env));
  const path = join(home, "config.json");
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(exampleConfigPath(), path);
  return { path, created: true };
}

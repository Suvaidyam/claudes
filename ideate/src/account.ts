import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudesBase } from "./home.js";

/**
 * The config folder of the claudes pool's current account, for a plain terminal where
 * CLAUDE_CONFIG_DIR is not set. undefined when it is already set, or when the pool's
 * files are missing, unreadable or do not name a usable account, or that account's
 * config folder does not exist. Never throws.
 */
export function poolConfigDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CLAUDE_CONFIG_DIR) return undefined;
  try {
    const base = claudesBase(env);
    const name = readFileSync(join(base, "current_profile"), "utf8").trim();
    if (!name) return undefined;
    const data = JSON.parse(readFileSync(join(base, "accounts.json"), "utf8")) as {
      accounts?: { name?: string; config_path?: string; path?: string }[];
    };
    const account = data.accounts?.find((a) => a?.name === name);
    const dir = account?.config_path || account?.path;
    return typeof dir === "string" && dir && existsSync(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

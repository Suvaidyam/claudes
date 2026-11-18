import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

const CommandProvider = z.object({
  type: z.literal("command"),
  cmd: z.string(),
  /**
   * How the prompt reaches the CLI:
   * - "stdin": written to stdin as plain text
   * - "stream-json": written to stdin as one agy stream-json message, {"event":"user","message":{"content":...}}
   * - "arg": "{prompt}" in args is replaced with the prompt (avoid: argv length limits, visible in `ps`)
   */
  args: z.array(z.string()).default([]),
  input: z.enum(["stdin", "stream-json", "arg"]).default("stdin"),
  /** Output is an NDJSON event stream of this flavour; enables live text deltas (see streams.ts). */
  stream: z.enum(["claude-stream-json", "codex-json", "agy-stream-json"]).optional(),
  timeoutSec: z.number().optional(),
  env: z.record(z.string()).optional(),
});

const MockProvider = z.object({
  type: z.literal("mock"),
  /** Review score starts here and climbs each round, to exercise convergence. */
  startScore: z.number().default(5),
  step: z.number().default(1.5),
  /** Throw a quota error on the Nth call (1-based), to exercise resume. */
  failOnCall: z.number().optional(),
  /** As primary: omit dispositions from the first revision answer, to exercise the follow-up. */
  skipDispositions: z.boolean().default(false),
  /** Emit output in ~40-char deltas spaced by this many ms, to exercise live streaming and stop. */
  chunkDelayMs: z.number().optional(),
});

export const ProviderConfig = z.discriminatedUnion("type", [CommandProvider, MockProvider]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

/** Reviewers are shown to the primary as "Reviewer A".."Reviewer Z". */
export const MAX_REVIEWERS = 26;

export const Config = z.object({
  primary: z.string(),
  secondaries: z.array(z.string()).min(1),
  loop: z
    .object({
      maxRounds: z.number().int().min(1).default(3),
      /** Converged when every reviewer scores >= passScore ... */
      passScore: z.number().default(8),
      /** ... and total open blockers <= maxBlockers. */
      maxBlockers: z.number().int().default(0),
      /** Stop if mean score fails to improve by minDelta for this many rounds. */
      stagnationRounds: z.number().int().default(2),
      minDelta: z.number().default(0.25),
      timeoutSec: z.number().default(300),
      /** Re-ask once with a repair prompt if JSON is unparseable. */
      repairAttempts: z.number().int().default(1),
    })
    .default({}),
  /** Optional review rubric; defaults to DEFAULT_RUBRIC in prompts.ts. */
  rubric: z.array(z.string()).optional(),
  providers: z.record(ProviderConfig),
  runsDir: z.string().default("runs"),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`Config ${path} is not valid JSON: ${e.message}`);
    throw e;
  }
  const cfg = Config.parse(raw);
  if (!isAbsolute(cfg.runsDir)) cfg.runsDir = resolve(dirname(resolve(path)), cfg.runsDir);
  for (const name of [cfg.primary, ...cfg.secondaries]) {
    if (!cfg.providers[name]) throw new Error(`Provider "${name}" not defined in config.providers`);
  }
  if (cfg.secondaries.includes(cfg.primary)) {
    throw new Error("Primary must not also be a secondary — self-review defeats the point");
  }
  if (new Set(cfg.secondaries).size !== cfg.secondaries.length) throw new Error("Each secondary may be listed only once");
  if (cfg.secondaries.length > MAX_REVIEWERS) throw new Error(`At most ${MAX_REVIEWERS} secondaries are supported`);
  return cfg;
}

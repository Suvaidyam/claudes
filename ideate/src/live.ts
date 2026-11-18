import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { endsMidLine, readJsonl } from "./jsonl.js";
import type { Role } from "./providers.js";

export type LiveEvent =
  | { t: "call_start"; call: number; provider: string; role: Role; round: number; ts: string }
  | { t: "delta"; call: number; text: string }
  | { t: "call_end"; call: number; ok: boolean; ms: number; error?: string; ts: string };

const FILE = "live.jsonl";

/** Append-only log of agent calls and their streamed text: one complete JSON event per line. */
export class LiveLog {
  private path: string;
  private next: number;
  /** A previous process died mid-write: start our first event on a fresh line. */
  private torn: boolean;

  constructor(runDir: string) {
    this.path = join(runDir, FILE);
    let last = 0;
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        try {
          const c = (JSON.parse(line) as { call?: unknown }).call;
          if (typeof c === "number" && c > last) last = c;
        } catch { /* blank or torn line */ }
      }
    }
    this.next = last + 1;
    this.torn = endsMidLine(this.path);
  }

  start(meta: { provider: string; role: Role; round: number }): number {
    const call = this.next++;
    this.write({ t: "call_start", call, ...meta, ts: new Date().toISOString() });
    return call;
  }

  delta(call: number, text: string): void {
    this.write({ t: "delta", call, text });
  }

  end(call: number, ok: boolean, ms: number, error?: string): void {
    this.write({ t: "call_end", call, ok, ms, ...(error ? { error } : {}), ts: new Date().toISOString() });
  }

  private write(e: LiveEvent): void {
    appendFileSync(this.path, (this.torn ? "\n" : "") + JSON.stringify(e) + "\n");
    this.torn = false;
  }
}

/**
 * Events from byte `fromOffset`; stops at the last newline so a half-written line is never returned.
 * A complete line that doesn't parse (torn by a crash) is skipped. `ends[i]` is the offset after `events[i]`.
 */
export function readLive(runDir: string, fromOffset: number): { events: LiveEvent[]; ends: number[]; offset: number } {
  const { values, ends, offset } = readJsonl(join(runDir, FILE), fromOffset);
  return { events: values as LiveEvent[], ends, offset };
}

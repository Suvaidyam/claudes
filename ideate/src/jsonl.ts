/**
 * Append-only JSON-lines files read by byte offset (live.jsonl, inbox.jsonl). Built to survive a
 * hard kill mid-write: a torn last line is never returned while it may still be completing, a
 * complete line that doesn't parse is skipped, and a later writer starts on a fresh line.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

/** Whether the file has content that doesn't end in "\n" (a write torn by a crash). */
export function endsMidLine(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * Parsed lines from byte `fromOffset`, up to the last "\n" so a half-written line is left for the
 * next read. Complete lines that aren't a JSON object are skipped; the offset still moves past them.
 * `ends[i]` is the byte offset just after `values[i]`, so a reader can resume after any one value.
 */
export function readJsonl(path: string, fromOffset: number): { values: Record<string, unknown>[]; ends: number[]; offset: number } {
  if (!existsSync(path)) return { values: [], ends: [], offset: fromOffset };
  const fd = openSync(path, "r");
  let buf: Buffer;
  try {
    const size = fstatSync(fd).size;
    if (size <= fromOffset) return { values: [], ends: [], offset: fromOffset };
    buf = Buffer.alloc(size - fromOffset);
    readSync(fd, buf, 0, buf.length, fromOffset);
  } finally {
    closeSync(fd);
  }
  const end = buf.lastIndexOf(0x0a) + 1;
  const values: Record<string, unknown>[] = [];
  const ends: number[] = [];
  // Split on bytes, not characters, so offsets stay byte offsets with multi-byte text.
  for (let start = 0; start < end; ) {
    const nl = buf.indexOf(0x0a, start);
    const line = buf.subarray(start, nl).toString("utf8");
    start = nl + 1;
    if (!line) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        values.push(v as Record<string, unknown>);
        ends.push(fromOffset + start);
      }
    } catch { /* torn or corrupt line: skip */ }
  }
  return { values, ends, offset: fromOffset + end };
}

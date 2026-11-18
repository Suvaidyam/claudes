export type StreamFormat = "claude-stream-json" | "codex-json" | "agy-stream-json";

export interface StreamParser {
  /** Feed a raw stdout chunk; returns the text deltas completed by it. Partial lines are buffered. */
  push(chunk: string): string[];
  /** Drain a final unterminated line. */
  flush(): string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The text carried by one decoded event, per CLI. */
const EXTRACTORS: Record<StreamFormat, (e: Obj) => string | undefined> = {
  "claude-stream-json": (e) => {
    if (e.type !== "stream_event") return undefined;
    const ev = obj(e.event);
    const delta = obj(ev?.delta);
    return ev?.type === "content_block_delta" && delta?.type === "text_delta" ? str(delta.text) : undefined;
  },
  // Codex emits no partial text: the whole message arrives as one completed item.
  "codex-json": (e) => {
    const item = obj(e.item);
    return e.type === "item.completed" && item?.type === "agent_message" ? str(item.text) : undefined;
  },
  "agy-stream-json": (e) => (e.event === "step_update" ? str(obj(e.step_update)?.text_delta) : undefined),
};

export function createStreamParser(format: StreamFormat): StreamParser {
  const extract = EXTRACTORS[format];
  let buffer = "";
  const parseLine = (line: string): string[] => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    try {
      const event = obj(JSON.parse(trimmed));
      const text = event && extract(event);
      return text ? [text] : [];
    } catch {
      return [];
    }
  };
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return lines.flatMap(parseLine);
    },
    flush() {
      const rest = buffer;
      buffer = "";
      return parseLine(rest);
    },
  };
}

/**
 * LLM CLIs wrap JSON in prose, code fences, or an outer envelope
 * (e.g. `claude -p --output-format json` returns {"result": "..."}).
 * Extract the first balanced JSON object that parses.
 */
export function extractJson(raw: string): unknown {
  const text = unwrapEnvelope(raw.trim());

  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const candidate of [...fenced, text]) {
    const obj = firstBalancedObject(candidate);
    if (obj !== undefined) return obj;
  }
  throw new Error("No parseable JSON object found in model output");
}

type Envelope = Record<string, unknown>;
const TEXT_KEYS = ["result", "response", "text", "output"] as const;

const asObject = (v: unknown): Envelope | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Envelope) : undefined;

/**
 * The CLI's outer JSON, if any:
 * - Claude Code `--output-format json`: {"type":"result","result":"...","is_error":false,...}
 * - Gemini CLI: {"response":"..."}
 * - Claude Code `--output-format stream-json`: NDJSON events ending in the {"type":"result",...} object
 * - `codex exec --json`: NDJSON thread/turn/item events (see codexEnvelope)
 * - agy `--output-format stream-json`: NDJSON events ending in {"event":"result","result":{"status":...,"response":"..."}}
 */
function parseEnvelope(text: string): Envelope | undefined {
  const streamResult = (o: Envelope | undefined) => (o?.event === "result" ? asObject(o.result) : undefined);
  try {
    const obj = asObject(JSON.parse(text));
    return streamResult(obj) ?? obj;
  } catch {
    /* not a single JSON document; may be an NDJSON event stream */
  }
  const lines = text.split("\n");
  if (lines.length < 2 || !lines[0]!.trimStart().startsWith("{")) return undefined;
  const events: Envelope[] = [];
  for (const line of lines) {
    try {
      const e = asObject(JSON.parse(line));
      if (e) events.push(e);
    } catch {
      /* skip non-JSON lines */
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const result = streamResult(e) ?? (e.type === "result" ? e : undefined);
    if (result) return result;
  }
  return codexEnvelope(events);
}

const CODEX_EVENTS = new Set(["thread.started", "turn.started", "item.completed", "turn.completed", "turn.failed", "error"]);

/** `codex exec --json`: synthesize an envelope from its thread/turn/item events. */
function codexEnvelope(events: Envelope[]): Envelope | undefined {
  if (!events.some((e) => typeof e.type === "string" && CODEX_EVENTS.has(e.type))) return undefined;
  let message: string | undefined;
  let completed = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "turn.completed") completed = true;
    else if (!completed && (e.type === "turn.failed" || e.type === "error")) {
      const detail = asObject(e.error)?.message ?? e.error ?? e.message;
      return { is_error: true, error: typeof detail === "string" && detail ? detail : "codex turn failed" };
    } else if (message === undefined && e.type === "item.completed") {
      const item = asObject(e.item);
      if (item?.type === "agent_message" && typeof item.text === "string") message = item.text;
    }
  }
  return message === undefined ? undefined : { result: message };
}

function unwrapEnvelope(text: string): string {
  const env = parseEnvelope(text);
  for (const key of TEXT_KEYS) {
    const v = env?.[key];
    if (typeof v === "string") return v;
  }
  return text;
}

function firstBalancedObject(s: string): unknown | undefined {
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/**
 * Some CLIs report failure inside a JSON envelope while still exiting 0, e.g. Claude Code's
 * {"is_error": true, "subtype": "error_...", "api_error_status": 429, "result": "usage limit reached"}
 * or Gemini CLI's {"error": {...}}. Returns a description of the error, or undefined if none.
 */
export function envelopeError(raw: string): string | undefined {
  const env = parseEnvelope(raw.trim());
  if (!env) return undefined;
  const subtype = typeof env.subtype === "string" ? env.subtype : "";
  const status = typeof env.status === "string" ? env.status : "";
  const hasError = env.error !== undefined && env.error !== null && env.error !== "";
  const textKey = TEXT_KEYS.find((k) => typeof env[k] === "string");
  // agy reports "SUCCESS" with an empty response when every tool it tried was denied.
  const empty = textKey !== undefined && (env[textKey] as string).trim() === "";
  const failed =
    env.is_error === true ||
    subtype.startsWith("error") ||
    (env.api_error_status !== undefined && env.api_error_status !== null) ||
    (status !== "" && !/^success$/i.test(status)) ||
    env.finished_reason === "error" ||
    (hasError && (textKey === undefined || empty)) ||
    empty;
  if (!failed) return undefined;
  const denied = Array.isArray(env.denied_actions) && env.denied_actions.length
    ? `denied tools: ${env.denied_actions.map((d) => asObject(d)?.display_name ?? asObject(d)?.action ?? "?").join(", ")}`
    : "";
  const parts = [
    subtype && `subtype ${subtype}`,
    status && !/^success$/i.test(status) && `status ${status}`,
    env.api_error_status != null && `status ${String(env.api_error_status)}`,
    typeof env.result === "string" && env.result.trim(),
    hasError && (typeof env.error === "string" ? env.error : JSON.stringify(env.error)),
    empty && "empty response",
    denied,
  ].filter(Boolean);
  return parts.join(" — ") || "CLI reported an error";
}

/** Plain-text output from a CLI, unwrapping a JSON envelope if present. */
export function extractText(raw: string): string {
  return unwrapEnvelope(raw.trim());
}

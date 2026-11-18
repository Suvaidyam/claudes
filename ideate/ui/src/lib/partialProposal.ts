/**
 * The revision's `"proposal"` text from a revise call's JSON while it is still streaming, so the
 * chat can show the new proposal as it is written. Tolerates text before the JSON (prose, a code
 * fence) and stops cleanly at a half-written escape.
 */
export function extractPartialProposal(partialJson: string): string | undefined {
  const s = partialJson;
  let i = s.indexOf("{");
  if (i < 0) return undefined;
  let depth = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "{" || c === "[") { depth++; i++; continue; }
    if (c === "}" || c === "]") { depth--; i++; if (depth <= 0) return undefined; continue; }
    if (c !== '"') { i++; continue; }
    const str = readString(s, i);
    if (!str.closed) return undefined;
    i = str.end;
    if (depth !== 1 || str.value !== "proposal") continue;
    const colon = skipSpace(s, i);
    if (s[colon] !== ":") continue; // a string value "proposal", not the key
    const v = skipSpace(s, colon + 1);
    if (s[v] !== '"') return undefined; // value not started yet (or not a string)
    return readString(s, v).value;
  }
  return undefined;
}

const skipSpace = (s: string, i: number): number => {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
};

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };

/** Decodes the JSON string starting at the quote `s[start]`; `closed` is false if the text ends first. */
function readString(s: string, start: number): { value: string; end: number; closed: boolean } {
  let out = "";
  let i = start + 1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') return { value: out, end: i + 1, closed: true };
    if (c !== "\\") { out += c; i++; continue; }
    const e = s[i + 1];
    if (e === undefined) break; // a lone trailing backslash: wait for the next delta
    if (e === "u") {
      const hex = s.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break; // \uXXXX not complete yet
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    out += ESCAPES[e] ?? e;
    i += 2;
  }
  // Unterminated: drop a high surrogate whose pair hasn't arrived.
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return { value: out, end: s.length, closed: false };
}

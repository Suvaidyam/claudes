/**
 * `ideate ui`: a local server for the chat front end. It never runs the loop itself: changes go
 * through detached CLI workers (spawn.ts), and the only files it writes are inbox.jsonl, a new
 * run's brief.md / input files, and a title edit while no worker is active. Live updates are
 * Server-Sent Events replayed from byte offsets in live.jsonl, so a closed tab misses nothing.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig, type Config } from "../config.js";
import { activeScenarios, findIssue, listRuns, pastIssues, summarize } from "../ideas.js";
import { appendInbox, readInbox, type InboxItem } from "../inbox.js";
import { readLive } from "../live.js";
import { renderReport } from "../report.js";
import { RunStore, type RunState } from "../store.js";
import { liveness } from "../worker.js";
import { buildConversation } from "./conversation.js";
import { defaultCliCommand, spawnWorker } from "./spawn.js";
import type { IdeaDetail } from "./types.js";

export interface ServerOptions {
  cfgPath: string;
  port: number;
  host: "127.0.0.1";
  /** argv prefix that launches the CLI; defaults to this install's CLI (see defaultCliCommand). */
  cliCommand?: string[];
}

const POLL_MS = 500;
/** A stop repeated this soon after one sent to the same pid isn't signalled again (a second SIGTERM force-exits). */
const STOP_REPEAT_MS = 10_000;
const PING_MS = 15_000;
const MAX_BODY = 10 * 1024 * 1024;
/** Texts longer than this, or starting with "@" (the CLI's file marker), go to the worker via a file. */
const MAX_ARG = 8000;
/**
 * The built front end, the first that exists relative to this module: "../web/" is the bundle's
 * web/ beside bin/ and also dist/web from dist/ui (compiled); "../../dist/web/" is dist/web from
 * src/ui (source). If none is built, the source path is kept and serveStatic says how to build it.
 */
const UI_DIR = ["../web/", "./web/", "../../dist/web/"]
  .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
  .find((dir) => existsSync(dir)) ?? fileURLToPath(new URL("../../dist/web/", import.meta.url));
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const text = z.string().refine((s) => s.trim().length > 0, "must not be empty");
const MessageBody = z.object({
  note: z.string().optional(),
  scenarios: z.array(text).optional(),
  editScenarios: z.array(z.object({ id: text, text })).optional(),
  removeScenarios: z.array(text).optional(),
  reopen: z.array(text).optional(),
  more: z.number().int().min(1).max(100).optional(),
});
type MessageBody = z.infer<typeof MessageBody>;
const NewIdeaBody = z.object({
  brief: text,
  title: z.string().max(200).optional(),
  rounds: z.number().int().min(1).max(100).optional(),
  reviewers: z.array(text).min(1).optional(),
});
const BranchBody = MessageBody.omit({ editScenarios: true, removeScenarios: true }).extend({ fromRound: z.number().int().min(1) });
const TitleBody = z.object({ title: text.pipe(z.string().max(200)) });

export async function startServer(opts: ServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  const cfgPath = resolve(opts.cfgPath);
  const cfg: Config = loadConfig(cfgPath);
  const runsDir = cfg.runsDir;
  const cli = opts.cliCommand ?? defaultCliCommand();
  /**
   * Workers this server started that may not have written worker.json yet: one process per idea.
   * An entry is removed when its process exits, so a pid in here is always our own child.
   */
  const pending = new Map<string, number>();
  const streams = new Set<() => void>();
  /** pid -> when this server last sent it SIGTERM. */
  const stopsSent = new Map<number, number>();
  let tsCounter = 0;

  const runDir = (id: string) => join(runsDir, id);
  /** The pid working on this idea, if any: worker.json via liveness() (one source of truth), else our own child. */
  const workerPid = (id: string): number | undefined => {
    const live = liveness(runDir(id));
    if (live.active) return live.pid;
    return pending.get(id);
  };
  const start = (id: string, args: string[], logId = id) => {
    let pid = 0;
    pid = spawnWorker(cli, cfgPath, args, runDir(logId), () => {
      if (pending.get(logId) === pid) pending.delete(logId);
    });
    pending.set(logId, pid);
  };

  /** Spawned by this server, but its worker hasn't written state.json yet. */
  const starting = (id: string) => ID_RE.test(id) && !existsSync(join(runDir(id), "state.json")) && workerPid(id) !== undefined;

  /** A worker started for this idea that exited before writing state.json: the end of its log says why. */
  function failedStart(id: string): string | undefined {
    if (!ID_RE.test(id) || existsSync(join(runDir(id), "state.json")) || workerPid(id) !== undefined) return undefined;
    let log: string;
    try { log = readFileSync(join(runDir(id), "worker.log"), "utf8"); } catch { return undefined; }
    const tail = log.trimEnd().split("\n").slice(-20).join("\n");
    return `Idea "${id}" failed to start:\n${tail || "(its worker.log is empty)"}`;
  }

  function loadState(id: string): RunState {
    if (starting(id)) throw new HttpError(503, `Idea "${id}" is starting; try again`);
    const failed = failedStart(id);
    if (failed) throw new HttpError(500, failed);
    if (!ID_RE.test(id) || !existsSync(join(runDir(id), "state.json"))) throw new HttpError(404, `No idea "${id}"`);
    try {
      return RunStore.load(runsDir, id).state;
    } catch {
      throw new HttpError(503, `Idea "${id}" is being written; try again`);
    }
  }

  function ideaDetail(id: string): IdeaDetail {
    const state = loadState(id);
    const dir = runDir(id);
    const active = workerPid(id) !== undefined;
    const queued = readInbox(dir, state.inboxConsumed ?? 0).items;
    const row = listRuns(runsDir).find((r) => r.id === id) ?? summarize(state, 0, 0, dir);
    const summary = { ...row, active, interrupted: state.status === "running" && !active };
    return {
      summary, state, messages: buildConversation(state, queued, active), queued,
      issues: pastIssues(state),
      // A legacy run (no stored maxRounds) may have more rounds than today's config allows.
      maxRounds: state.maxRounds ?? Math.max(cfg.loop.maxRounds, state.rounds.length),
    };
  }

  /** A text flag value the CLI reads literally: long texts and ones starting with "@" go via a file. */
  function textArg(dir: string, value: string): string {
    if (!value.startsWith("@") && value.length <= MAX_ARG) return value;
    const inputs = join(dir, "ui-input");
    mkdirSync(inputs, { recursive: true });
    const path = join(inputs, `${Date.now()}-${++tsCounter}.md`);
    writeFileSync(path, value);
    return `@${path}`;
  }

  /** `continue` flags for a message; `--flag=value` so values starting with "-" stay values. */
  function continueArgs(dir: string, m: MessageBody): string[] {
    const args: string[] = [];
    if (m.note?.trim()) args.push(`--note=${textArg(dir, m.note)}`);
    for (const s of m.scenarios ?? []) args.push(`--scenario=${textArg(dir, s)}`);
    for (const e of m.editScenarios ?? []) args.push(`--edit-scenario=${e.id.trim()}=${textArg(dir, e.text)}`);
    for (const id of m.removeScenarios ?? []) args.push(`--remove-scenario=${id.trim()}`);
    for (const ref of m.reopen ?? []) args.push(`--reopen=${ref.trim()}`);
    if (m.more !== undefined) args.push(`--more=${m.more}`);
    return args;
  }

  /** Rejects unknown scenario ids and issue refs up front, instead of a worker failing in its log. */
  function checkRefs(state: RunState, m: MessageBody): void {
    const ids = new Set(activeScenarios(state).map((s) => s.id.toLowerCase()));
    for (const id of [...(m.editScenarios ?? []).map((e) => e.id), ...(m.removeScenarios ?? [])]) {
      if (!ids.has(id.trim().toLowerCase())) throw new HttpError(400, `No active scenario "${id}"`);
    }
    for (const ref of m.reopen ?? []) {
      try { findIssue(state, ref); } catch (e) { throw new HttpError(400, (e as Error).message); }
    }
  }

  /**
   * An idle idea that `continue` can't take a message for: interrupted (still marked running), no
   * round yet, or its last round already revised. Resuming keeps its stored round budget.
   */
  const needsResume = (state: RunState) =>
    state.status === "running" || !state.rounds.length || !!state.rounds[state.rounds.length - 1]!.revision;

  const isEmpty = (m: MessageBody) =>
    !m.note?.trim() && !m.scenarios?.length && !m.editScenarios?.length && !m.removeScenarios?.length && !m.reopen?.length && m.more === undefined;

  function inboxItems(m: MessageBody): InboxItem[] {
    // Unique ts per item: `more` items are de-duplicated by ts.
    const ts = () => `${new Date().toISOString()}#${++tsCounter}`;
    const items: InboxItem[] = [];
    if (m.note?.trim()) items.push({ type: "note", text: m.note, ts: ts() });
    for (const s of m.scenarios ?? []) items.push({ type: "add_scenario", text: s, ts: ts() });
    for (const e of m.editScenarios ?? []) items.push({ type: "edit_scenario", id: e.id.trim(), text: e.text, ts: ts() });
    for (const id of m.removeScenarios ?? []) items.push({ type: "remove_scenario", id: id.trim(), ts: ts() });
    for (const ref of m.reopen ?? []) items.push({ type: "reopen", ref: ref.trim(), ts: ts() });
    if (m.more !== undefined) items.push({ type: "more", n: m.more, ts: ts() });
    return items;
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const method = req.method ?? "GET";
    const parts = path.split("/").slice(2).map(decodeURIComponent); // ["ideas", id?, action?]
    if (path === "/api/config" && method === "GET") {
      return json(res, 200, { primary: cfg.primary, secondaries: cfg.secondaries, maxRounds: cfg.loop.maxRounds });
    }
    if (parts[0] !== "ideas" || parts.length > 3) throw new HttpError(404, "Not found");
    const [, id, action] = parts;

    if (id === undefined) {
      if (method === "GET") {
        return json(res, 200, listRuns(runsDir).map((r) => {
          const active = workerPid(r.id) !== undefined;
          return { ...r, active, interrupted: r.status === "running" && !active };
        }));
      }
      if (method === "POST") {
        const body = parse(NewIdeaBody, await readBody(req));
        for (const r of body.reviewers ?? []) {
          if (!cfg.providers[r] || r === cfg.primary) throw new HttpError(400, `"${r}" can't be a reviewer`);
        }
        const newId = RunStore.newId();
        const dir = runDir(newId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "brief.md"), body.brief);
        const args = ["run", `--id=${newId}`, `--brief=@${join(dir, "brief.md")}`];
        if (body.title?.trim()) args.push(`--title=${body.title.trim()}`);
        if (body.rounds !== undefined) args.push(`--rounds=${body.rounds}`);
        if (body.reviewers) args.push(`--reviewers=${body.reviewers.map((r) => r.trim()).join(",")}`);
        start(newId, args);
        return json(res, 201, { id: newId });
      }
      throw new HttpError(404, "Not found");
    }

    const route = `${method} ${action ?? ""}`;
    switch (route) {
      case "GET ":
        return json(res, 200, ideaDetail(id));
      case "GET live":
        if (!starting(id)) loadState(id);
        return liveStream(req, res, id, query);
      case "GET report":
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
        res.end(renderReport(loadState(id)));
        return;
      case "PATCH ": {
        const { title } = parse(TitleBody, await readBody(req));
        loadState(id);
        if (workerPid(id) !== undefined) throw new HttpError(409, "Rename once the idea has stopped working");
        const { store, state } = RunStore.load(runsDir, id);
        state.title = title.trim();
        store.save(state);
        return json(res, 200, { ok: true });
      }
      case "POST messages": {
        const body = parse(MessageBody, await readBody(req));
        if (isEmpty(body)) throw new HttpError(400, "Nothing to send");
        const state = loadState(id);
        if (workerPid(id) !== undefined) {
          for (const item of inboxItems(body)) appendInbox(runDir(id), item);
          return json(res, 202, { queued: true });
        }
        checkRefs(state, body);
        if (needsResume(state)) {
          // `continue` can't pick these up (it would fail in the worker, after the 202): queue the
          // message and resume; the loop drains the inbox before its next revision.
          for (const item of inboxItems(body)) appendInbox(runDir(id), item);
          start(id, ["resume", id]);
          return json(res, 202, { queued: true, resumed: true });
        }
        start(id, ["continue", id, ...continueArgs(runDir(id), body)]);
        return json(res, 202, { queued: false });
      }
      case "POST branch": {
        const body = parse(BranchBody, await readBody(req));
        const state = loadState(id);
        const from = state.rounds[body.fromRound - 1];
        if (!from || from.meanScore === undefined) throw new HttpError(400, `Round ${body.fromRound} has no review to branch from`);
        checkRefs(state, body);
        const newId = RunStore.newId();
        start(id, ["continue", id, `--from-round=${body.fromRound}`, `--branch-id=${newId}`, ...continueArgs(runDir(newId), body)], newId);
        return json(res, 201, { id: newId });
      }
      case "POST resume":
        loadState(id);
        if (workerPid(id) !== undefined) throw new HttpError(409, "This idea is already being worked on");
        start(id, ["resume", id]);
        return json(res, 202, { ok: true });
      case "POST stop": {
        loadState(id);
        const pid = workerPid(id);
        if (pid === undefined) throw new HttpError(409, "This idea isn't running");
        const now = Date.now();
        for (const [p, t] of stopsSent) if (now - t > STOP_REPEAT_MS) stopsSent.delete(p);
        if (!stopsSent.has(pid)) {
          process.kill(pid, "SIGTERM");
          stopsSent.set(pid, now);
        }
        return json(res, 202, { ok: true });
      }
    }
    throw new HttpError(404, "Not found");
  }

  /** SSE: live.jsonl events from `from` (each with the offset after it), then `state` on every change. */
  function liveStream(req: IncomingMessage, res: ServerResponse, id: string, query: URLSearchParams): void {
    const raw = query.get("from") ?? "0";
    if (!/^\d+$/.test(raw)) throw new HttpError(400, "from must be a byte offset");
    let offset = Number(raw);
    const dir = runDir(id);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let lastSig = "";
    const signature = () => {
      const st = statSync(join(dir, "state.json"), { throwIfNoEntry: false });
      const inbox = statSync(join(dir, "inbox.jsonl"), { throwIfNoEntry: false });
      return `${st?.mtimeMs}:${st?.size}:${inbox?.size}:${workerPid(id) !== undefined}`;
    };
    const tick = () => {
      try {
        const { events, ends } = readLive(dir, offset);
        events.forEach((event, i) => {
          offset = ends[i]!;
          send("live", { offset, event });
        });
        const sig = signature();
        if (sig !== lastSig) {
          // A state.json caught mid-replace fails to parse: keep the old signature and retry next poll.
          const detail = ideaDetail(id);
          lastSig = sig;
          send("state", detail);
        }
      } catch (e) {
        // The worker died before writing state.json (or the idea is gone): say so and end the
        // stream, instead of retrying forever. Anything else is unreadable for now: poll again.
        if (e instanceof HttpError && e.status !== 503) {
          send("failed", { error: e.message });
          stop();
        }
      }
    };
    const poll = setInterval(tick, POLL_MS);
    const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
    const stop = () => {
      clearInterval(poll);
      clearInterval(ping);
      streams.delete(stop);
      res.end();
    };
    streams.add(stop);
    req.on("close", stop);
    tick();
  }

  let port = 0; // the bound port, known once listening (tests listen on port 0)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    const handle = Promise.resolve().then(() => {
      checkSameOrigin(req, port, isApi);
      return isApi ? api(req, res, url.pathname, url.searchParams) : serveStatic(req, res, url.pathname);
    });
    handle.catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (res.headersSent) res.end();
      else json(res, status, { error: (e as Error).message });
    });
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port, opts.host, () => { server.off("error", fail); ok(); });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://${opts.host}:${port}`,
    close: () => new Promise<void>((ok) => {
      for (const stop of [...streams]) stop();
      server.close(() => ok());
      server.closeAllConnections();
    }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw new HttpError(400, `${i.path.join(".") || "body"}: ${i.message}`);
  }
  return r.data;
}

/**
 * Only this machine's own pages may use the server. Binding 127.0.0.1 doesn't stop a website in
 * the user's browser from POSTing to it (CSRF) or reading it after DNS rebinding, so:
 * - Host must be 127.0.0.1:<port> or localhost:<port> (a rebound name fails this);
 * - a non-GET /api request carrying Origin must come from that same origin.
 * Dev server (Task 7): the Vite proxy for /api must use `changeOrigin: true` (Host becomes the
 * target) and `headers: { origin: "http://127.0.0.1:4317" }` so proxied writes pass the Origin check.
 */
function checkSameOrigin(req: IncomingMessage, port: number, isApi: boolean): void {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes((req.headers.host ?? "").toLowerCase())) throw new HttpError(403, "Forbidden host");
  const origin = req.headers.origin;
  if (isApi && req.method !== "GET" && req.method !== "HEAD" && origin !== undefined
    && !allowed.some((h) => origin.toLowerCase() === `http://${h}`)) {
    throw new HttpError(403, "Cross-origin requests are not allowed");
  }
}

/** JSON bodies only: a cross-site form or text/plain POST never gets parsed. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (hasBody && type !== "application/json") {
    req.resume();
    throw new HttpError(415, "Send the body as application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(400, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".map": "application/json",
};

/** The built front end from dist/web, with index.html for any other path (hash routing). */
function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 404, { error: "Not found" });
  const index = join(UI_DIR, "index.html");
  if (!existsSync(index)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>ideate</title><p>The UI isn't built yet (no dist/web). Run npm run build, then restart <code>ideate ui</code>.</p>");
    return;
  }
  let file = index;
  try {
    const candidate = resolve(UI_DIR, `.${decodeURIComponent(pathname)}`);
    if (candidate.startsWith(UI_DIR.endsWith(sep) ? UI_DIR : UI_DIR + sep) && statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      file = candidate;
    }
  } catch { /* bad escape: fall back to index.html */ }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(req.method === "HEAD" ? undefined : readFileSync(file));
}

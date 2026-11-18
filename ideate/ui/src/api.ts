/** The ideate ui server's REST API. Same origin only; writes send JSON. */
import type { RunSummary } from "../../src/ideas";
import type { IdeaDetail } from "../../src/ui/types";

export interface MessageBody {
  note?: string;
  scenarios?: string[];
  editScenarios?: { id: string; text: string }[];
  removeScenarios?: string[];
  reopen?: string[];
  more?: number;
}
export interface NewIdeaBody { brief: string; title?: string; rounds?: number; reviewers?: string[] }
export type BranchBody = Omit<MessageBody, "editScenarios" | "removeScenarios"> & { fromRound: number };

export interface UiConfig { primary: string; secondaries: string[]; maxRounds: number }

/** A non-2xx reply; `message` is the server's `{ error }`. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown, base = "/api/ideas"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Couldn't reach the ideate ui server. Is it still running?");
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new ApiError(res.status, err?.error ?? `${method} ${base}${path} failed (${res.status})`);
  }
  return (res.headers.get("content-type")?.startsWith("application/json") ? res.json() : res.text()) as Promise<T>;
}

const at = (id: string) => `/${encodeURIComponent(id)}`;

export const getConfig = () => call<UiConfig>("GET", "", undefined, "/api/config");
export const listIdeas = () => call<RunSummary[]>("GET", "");
export const getIdea = (id: string) => call<IdeaDetail>("GET", at(id));
export const createIdea = (body: NewIdeaBody) => call<{ id: string }>("POST", "", body);
export const sendMessage = (id: string, body: MessageBody) => call<{ queued: boolean }>("POST", `${at(id)}/messages`, body);
export const branch = (id: string, body: BranchBody) => call<{ id: string }>("POST", `${at(id)}/branch`, body);
export const resume = (id: string) => call<{ ok: true }>("POST", `${at(id)}/resume`);
export const stop = (id: string) => call<{ ok: true }>("POST", `${at(id)}/stop`);
export const rename = (id: string, title: string) => call<{ ok: true }>("PATCH", at(id), { title });
/** The run's markdown report. */
export const report = (id: string) => call<string>("GET", `${at(id)}/report`);

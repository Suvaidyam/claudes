/**
 * Live agent output for the open idea: the server's SSE replay of live.jsonl (`live` events, each
 * with the byte offset after it) plus `state` events carrying a fresh IdeaDetail. Reconnects resume
 * from the last offset seen, and the reducer drops anything at or before it, so text is never
 * duplicated or lost across a dropped connection or a closed tab.
 */
import { useEffect, useRef, useState } from "react";
import type { LiveEvent } from "../../../src/live";
import type { Role } from "../../../src/providers";
import type { ChatMessage, IdeaDetail } from "../../../src/ui/types";
import { extractPartialProposal } from "./partialProposal";

export interface LiveCall {
  provider: string;
  role: Role;
  round: number;
  /** When the call started (for the elapsed-time status). */
  ts: string;
  text: string;
  done: boolean;
  ok?: boolean;
}
export interface LiveState { offset: number; calls: Record<number, LiveCall> }
export type LiveFrame = { offset: number; event: LiveEvent };

export const EMPTY_LIVE: LiveState = { offset: 0, calls: {} };

export function liveReducer(state: LiveState, ev: LiveFrame): LiveState {
  if (ev.offset <= state.offset) return state; // already applied: a replay after reconnecting
  const e = ev.event;
  const cur = state.calls[e.call];
  let next: LiveCall | undefined;
  switch (e.t) {
    case "call_start":
      next = { provider: e.provider, role: e.role, round: e.round, ts: e.ts, text: "", done: false };
      break;
    case "delta":
      if (cur) next = { ...cur, text: cur.text + e.text };
      break;
    case "call_end":
      if (cur) next = { ...cur, done: true, ok: e.ok };
      break;
  }
  return { offset: ev.offset, calls: next ? { ...state.calls, [e.call]: next } : state.calls };
}

export type LivePhase = "streaming" | "done" | "interrupted";
export interface LiveTurn extends LiveCall {
  call: number;
  phase: LivePhase;
  /** A revise call's proposal so far. */
  proposal?: string;
  /**
   * A later revise call of the same round that writes no proposal (the follow-up asking only for
   * missing dispositions): `proposal` is the earlier call's, so the streamed revision stays shown.
   */
  followUp?: true;
}

/** The chat message a call's result becomes once state.json records it. */
const messageKey = (c: LiveCall): string =>
  c.role === "generate" ? `r${c.round}-proposal` : c.role === "revise" ? `r${c.round}-revision` : `r${c.round}-review-${c.provider}`;
const sameTurn = (a: LiveCall, b: LiveCall) => a.provider === b.provider && a.role === b.role && a.round === b.round;
/** Reviews of one round run in parallel, so a sibling review starting later doesn't end this one. */
const parallel = (a: LiveCall, b: LiveCall) => a.role === "review" && b.role === "review" && a.round === b.round && a.provider !== b.provider;

/**
 * The live calls to show below the formatted messages. A call disappears once its formatted
 * message is in `messages`. A call with no call_end is abandoned (its worker was killed) once a
 * later, non-parallel call has started or the idea is no longer active: it is never shown as
 * streaming, only as "interrupted" (or not at all if a retry of the same turn took over).
 * Finished calls stay until their formatted message lands; failed ones are dropped. A revise
 * follow-up without a proposal of its own carries the earlier call's (see LiveTurn.followUp).
 */
export function liveTurns(live: LiveState, messages: ChatMessage[], active: boolean): LiveTurn[] {
  const keys = new Set(messages.map((m) => m.key));
  const ids = Object.keys(live.calls).map(Number).sort((a, b) => a - b);
  const out: LiveTurn[] = [];
  for (const call of ids) {
    const c = live.calls[call]!;
    if (keys.has(messageKey(c)) || (c.done && !c.ok)) continue;
    const later = ids.filter((j) => j > call).map((j) => live.calls[j]!);
    if (later.some((l) => sameTurn(l, c))) continue;
    const superseded = later.some((l) => !parallel(c, l));
    const turn: LiveTurn = { ...c, call, phase: c.done ? "done" : active && !superseded ? "streaming" : "interrupted" };
    if (c.role === "revise") Object.assign(turn, reviseProposal(live, ids.filter((j) => j < call), c));
    if (!c.done || (active && !superseded)) out.push(turn);
  }
  return out;
}

/** A revise call's proposal so far, or else the last earlier finished same-turn call's. */
function reviseProposal(live: LiveState, earlier: number[], c: LiveCall): Pick<LiveTurn, "proposal" | "followUp"> {
  const own = extractPartialProposal(c.text);
  if (own !== undefined) return { proposal: own };
  for (const j of [...earlier].reverse()) {
    const e = live.calls[j]!;
    if (!sameTurn(e, c) || !e.done || !e.ok) continue;
    const prev = extractPartialProposal(e.text);
    if (prev !== undefined) return { proposal: prev, followUp: true };
  }
  return {};
}

/**
 * Streams `/api/ideas/:id/live` for the open idea and returns its live state; `onState` gets each
 * `state` event's IdeaDetail. The EventSource is closed on idea switch and unmount; after an error
 * it reopens (with backoff) from the last offset seen. A `failed` event (the idea's worker died
 * before it had a state, e.g. it couldn't start) ends the stream and goes to `onFailed`.
 */
export function useLive(id: string | undefined, onState: (d: IdeaDetail) => void, onFailed?: (message: string) => void): LiveState {
  const [cur, setCur] = useState<{ id?: string; live: LiveState }>({ live: EMPTY_LIVE });
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;

  useEffect(() => {
    setCur({ id, live: EMPTY_LIVE });
    if (!id) return;
    let offset = 0;
    let es: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let closed = false;
    // Apply events once per frame: a replay of a long run is thousands of events.
    let pending: LiveFrame[] = [];
    let frame: number | undefined;
    const flush = () => {
      frame = undefined;
      const batch = pending;
      pending = [];
      setCur((c) => (c.id === id ? { id, live: batch.reduce(liveReducer, c.live) } : c));
    };
    const connect = () => {
      es = new EventSource(`/api/ideas/${encodeURIComponent(id)}/live?from=${offset}`);
      es.addEventListener("open", () => { delay = 1000; });
      es.addEventListener("live", (e) => {
        const ev = JSON.parse((e as MessageEvent<string>).data) as LiveFrame;
        if (ev.offset <= offset) return;
        offset = ev.offset;
        pending.push(ev);
        frame ??= requestAnimationFrame(flush);
      });
      es.addEventListener("state", (e) => onStateRef.current(JSON.parse((e as MessageEvent<string>).data) as IdeaDetail));
      es.addEventListener("failed", (e) => {
        closed = true;
        es?.close();
        onFailedRef.current?.((JSON.parse((e as MessageEvent<string>).data) as { error: string }).error);
      });
      es.onerror = () => {
        // Reopen ourselves rather than let the browser retry the original ?from= URL.
        es?.close();
        if (closed) return;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      clearTimeout(retry);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [id]);

  return cur.id === id ? cur.live : EMPTY_LIVE;
}

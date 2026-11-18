import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, IdeaDetail } from "../../../src/ui/types";
import { ApiError, getIdea } from "../api";
import { withOptimistic } from "./composer";
import { liveTurns, useLive, type LiveTurn } from "./liveStream";

interface Pending { id: number; msgs: ChatMessage[]; sent: boolean }

/**
 * The open idea: its detail (first GET, then every `state` event), the live turns, and messages
 * just sent that the server hasn't reported back yet. `addPending` shows them at once; `settle`
 * marks them sent (the next `state` event replaces them) or drops them after an error.
 */
export function useIdea(selected: string | undefined, onStateEvent: () => void) {
  const [detail, setDetail] = useState<IdeaDetail>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<Pending[]>([]);
  /** A `state` event arrived for the open idea: a slower initial GET must not overwrite it. */
  const streamed = useRef(false);
  const nextId = useRef(0);

  useEffect(() => {
    setDetail(undefined);
    setError(undefined);
    setPending([]);
    streamed.current = false;
    if (!selected) return;
    let cancelled = false;
    getIdea(selected).then(
      (d) => { if (!cancelled && !streamed.current) setDetail(d); },
      (e: Error) => {
        // 503: just created and still starting; its first `state` event brings the detail.
        if (!cancelled && !streamed.current && !(e instanceof ApiError && e.status === 503)) setError(e.message);
      },
    );
    return () => { cancelled = true; };
  }, [selected]);

  const onState = useCallback((d: IdeaDetail) => {
    streamed.current = true;
    setDetail(d);
    setError(undefined);
    setPending((p) => (p.some((x) => x.sent) ? p.filter((x) => !x.sent) : p));
    onStateEvent();
  }, [onStateEvent]);
  const live = useLive(selected, onState, setError);

  const turns: LiveTurn[] = useMemo(
    () => (detail ? liveTurns(live, detail.messages, detail.summary.active) : []),
    [live, detail],
  );
  const messages = useMemo(
    () => (detail ? withOptimistic(detail.messages, pending.flatMap((p) => p.msgs)) : []),
    [detail, pending],
  );

  const addPending = useCallback((msgs: ChatMessage[]) => {
    const id = ++nextId.current;
    setPending((p) => [...p, { id, msgs, sent: false }]);
    return (ok: boolean) => setPending((p) => (ok ? p.map((x) => (x.id === id ? { ...x, sent: true } : x)) : p.filter((x) => x.id !== id)));
  }, []);

  return { detail, error, turns, messages, addPending };
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunSummary } from "../../src/ideas";
import * as api from "./api";
import { Composer, type ComposerHandle } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Header } from "./components/Header";
import type { EndActions } from "./components/Message";
import { NewIdea } from "./components/NewIdea";
import { ReportView } from "./components/ReportView";
import { Sidebar } from "./components/Sidebar";
import { optimisticMessages } from "./lib/composer";
import { useFollowBottom } from "./lib/useFollowBottom";
import { useIdea } from "./lib/useIdea";

const HASH = /^#\/idea\/(.+)$/;
/** The open idea from the URL; a malformed escape (e.g. "#/idea/%") means no selection. */
const idFromHash = (): string | undefined => {
  const m = HASH.exec(window.location.hash);
  try {
    return m?.[1] ? decodeURIComponent(m[1]) : undefined;
  } catch {
    return undefined;
  }
};
const open = (id: string) => { window.location.hash = `#/idea/${encodeURIComponent(id)}`; };

const LIST_POLL_MS = 10_000;

export function App() {
  const [ideas, setIdeas] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState(idFromHash);
  const [listError, setListError] = useState<string>();
  /** The last failed action, shown above the composer until dismissed. */
  const [actionError, setActionError] = useState<string>();
  const [reportOpen, setReportOpen] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const thread = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onHash = () => setSelected(idFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => { setActionError(undefined); setReportOpen(false); }, [selected]);

  const refreshList = useCallback(() => {
    api.listIdeas().then(
      (rows) => { setIdeas(rows); setListError(undefined); },
      (e: Error) => setListError(e.message),
    );
  }, []);

  useEffect(() => {
    refreshList();
    const t = setInterval(refreshList, LIST_POLL_MS);
    return () => clearInterval(t);
  }, [refreshList]);

  const { detail, error: detailError, turns, messages, addPending } = useIdea(selected, refreshList);
  const onThreadScroll = useFollowBottom(thread, selected, [messages, turns]);

  /** Runs an API action for the open idea; a failure goes to the banner and rejects. */
  const act = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      const out = await fn();
      setActionError(undefined);
      refreshList();
      return out;
    } catch (e) {
      setActionError((e as Error).message);
      throw e;
    }
  }, [refreshList]);
  const quiet = (p: Promise<unknown>) => { p.catch(() => { /* shown in the banner */ }); };

  const send = async (body: api.MessageBody) => {
    if (!detail) return;
    const id = detail.state.id;
    const active = detail.summary.active;
    const settle = addPending(optimisticMessages(
      body, detail.state.rounds.length, active ? "Queued · used in the next revision" : "Sending…", `pending-${Date.now()}`,
    ));
    try {
      await act(() => api.sendMessage(id, body));
      settle(true);
    } catch (e) {
      settle(false);
      throw e;
    }
  };
  const onBranch = (round: number) => {
    if (detail) quiet(act(() => api.branch(detail.state.id, { fromRound: round })).then(({ id }) => open(id)));
  };
  const actions: EndActions | undefined = detail && {
    rounds: detail.state.rounds,
    onContinue: () => composer.current?.focus(),
    onResume: () => quiet(act(() => api.resume(detail.state.id))),
    onReport: () => setReportOpen(true),
    onBranch,
  };

  return (
    <div className="app">
      <Sidebar ideas={ideas} selected={selected} />
      <main className="main">
        {detail && <Header detail={detail} onRename={(t) => act(() => api.rename(detail.state.id, t)).then(() => undefined)} />}
        <div className="thread" ref={thread} onScroll={onThreadScroll}>
          {listError && <div className="notice error">Couldn't load ideas: {listError}</div>}
          {detailError && <div className="notice error">{detailError}</div>}
          {!selected && <div className="notice">What should we work on? Write or paste a brief below.</div>}
          {selected && !detail && !detailError && <div className="notice">Loading…</div>}
          {detail && actions && <Conversation detail={detail} messages={messages} live={turns} actions={actions} />}
        </div>
        {actionError && (
          <div className="banner" role="alert">
            <span>{actionError}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setActionError(undefined)}>×</button>
          </div>
        )}
        {!selected && <NewIdea onCreated={open} onError={setActionError} />}
        {detail && (
          <Composer
            key={detail.state.id} ref={composer} detail={detail} onSend={send} onBranch={onBranch}
            onStop={() => act(() => api.stop(detail.state.id)).then(() => undefined)}
          />
        )}
      </main>
      {reportOpen && detail && <ReportView id={detail.state.id} onClose={() => setReportOpen(false)} />}
    </div>
  );
}

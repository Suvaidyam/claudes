import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { report } from "../api";

/** The run's final report in a modal; Esc or Close returns focus to whatever opened it. */
export function ReportView({ id, onClose }: { id: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [md, setMd] = useState<string>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    report(id).then(
      (text) => { if (!cancelled) setMd(text); },
      (e: Error) => { if (!cancelled) setError(e.message); },
    );
    return () => { cancelled = true; };
  }, [id]);

  const copy = () => {
    if (md === undefined) return;
    navigator.clipboard.writeText(md).then(() => setCopied("Copied"), () => setCopied("Couldn't copy"));
  };

  return (
    <dialog ref={dialog} className="report" aria-label="Final proposal" onClose={onClose}>
      <div className="report-bar">
        <b>Final proposal</b>
        {copied && <span className="muted" role="status">{copied}</span>}
        <button type="button" className="a" onClick={copy} disabled={md === undefined}>Copy markdown</button>
        <button type="button" className="a" onClick={() => dialog.current?.close()}>Close</button>
      </div>
      <div className="report-body">
        {error && <div className="notice error">{error}</div>}
        {md === undefined && !error && <div className="notice">Loading…</div>}
        {md !== undefined && <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{md}</Markdown></div>}
      </div>
    </dialog>
  );
}

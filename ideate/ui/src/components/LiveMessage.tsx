import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { avatar } from "../lib/format";
import type { LiveTurn } from "../lib/liveStream";

const REVIEW_TAIL = 600;

/** An agent call still being written (or cut off): what it has produced so far. */
export function LiveMessage({ turn, secondaries }: { turn: LiveTurn; secondaries: string[] }) {
  const streaming = turn.phase === "streaming";
  const elapsed = useElapsed(turn.ts, streaming);
  const av = avatar(turn.role === "review" ? "reviewer" : "primary", turn.provider, secondaries);
  const doing = turn.role === "generate" ? `proposing round ${turn.round}`
    : turn.role === "revise" ? `revising round ${turn.round}` : `reviewing round ${turn.round}`;
  const status = turn.phase === "interrupted" ? `${doing} · interrupted`
    : turn.phase === "done" ? `${doing} · done`
    : turn.followUp ? `${doing} · checking answers… ${elapsed}` : `${doing} · ${elapsed}`;

  let body;
  if (turn.role === "review") {
    body = <pre className="raw">{turn.text.length > REVIEW_TAIL ? `…${turn.text.slice(-REVIEW_TAIL)}` : turn.text}</pre>;
  } else {
    const md = turn.role === "revise" ? turn.proposal ?? "" : turn.text;
    body = <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{md}</Markdown></div>;
  }

  return (
    <div className={`msg live${turn.phase === "interrupted" ? " cut" : ""}`}>
      <div className="av" style={{ background: av.color }}>{av.letter}</div>
      <div className="body">
        <div className="who">{turn.provider} <span>· {status}</span></div>
        <div className="card">
          {body}
          {streaming && <span className="cursor" aria-label="Writing" />}
        </div>
      </div>
    </div>
  );
}

/** "12s" / "3m 05s" since `ts`, ticking every second while `running`. */
function useElapsed(ts: string, running: boolean): string {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const s = Math.max(0, Math.floor((now - Date.parse(ts)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

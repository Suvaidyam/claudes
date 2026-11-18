import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Issue } from "../../../src/schema";
import type { RoundRecord } from "../../../src/store";
import type { ChatMessage } from "../../../src/ui/types";
import { avatar, clipLines, splitIssues } from "../lib/format";
import { BranchPicker } from "./BranchPicker";

const MAX_LINES = 40;
/** A pasted brief can be one 200 KB line: clip by characters too. */
const MAX_CHARS = 3000;

/** What the end card's buttons do. */
export interface EndActions {
  onContinue(): void;
  onResume(): void;
  onReport(): void;
  onBranch(round: number): void;
  rounds: RoundRecord[];
}

export function Message({ msg, secondaries, actions }: { msg: ChatMessage; secondaries: string[]; actions?: EndActions }) {
  switch (msg.kind) {
    case "round_divider":
      return <div className="round">{msg.status}</div>;
    case "end":
      return <EndCard msg={msg} actions={actions} />;
    case "brief":
    case "owner":
    case "queued":
      return <YouBubble msg={msg} />;
  }
  const av = avatar(msg.speaker, msg.name, secondaries);
  return (
    <div className="msg">
      <div className="av" style={{ background: av.color }}>{av.letter}</div>
      <div className="body">
        <div className="who">{msg.name} <span>· {msg.status}</span></div>
        <div className="card">
          {msg.review ? <Review review={msg.review} /> : <Proposal markdown={msg.markdown ?? ""} />}
        </div>
      </div>
    </div>
  );
}

function EndCard({ msg, actions }: { msg: ChatMessage; actions?: EndActions }) {
  const end = msg.end;
  return (
    <div className="end">
      <div>
        <b>{msg.status.replace(/_/g, " ")}</b>
        {end?.detail && <span> · {end.detail}</span>}
      </div>
      {actions && end && end.actions.length > 0 && (
        <div className="acts">
          {end.actions.map((a) => {
            switch (a) {
              case "continue": return <button key={a} type="button" className="a" onClick={actions.onContinue}>Continue</button>;
              case "resume": return <button key={a} type="button" className="a" onClick={actions.onResume}>Resume</button>;
              case "branch": return <BranchPicker key={a} rounds={actions.rounds} onPick={actions.onBranch} down />;
              case "report": return <button key={a} type="button" className="a" onClick={actions.onReport}>View final proposal</button>;
            }
          })}
        </div>
      )}
    </div>
  );
}

function YouBubble({ msg }: { msg: ChatMessage }) {
  const o = msg.owner;
  return (
    <div className="you">
      {msg.markdown && <Clipped markdown={msg.markdown} more={msg.kind === "brief" ? "Show full brief" : "Show more"} />}
      {o && (
        <ul className="owner">
          {o.scenarios.map((s) => <li key={s}>Scenario {s}</li>)}
          {o.reopened.map((r) => <li key={r}>Reopened {r}</li>)}
          {o.note && <li>Note: {o.note}</li>}
          {o.more !== undefined && <li>{o.more} more round{o.more === 1 ? "" : "s"}</li>}
        </ul>
      )}
      <small>{msg.status}</small>
    </div>
  );
}

const Proposal = ({ markdown }: { markdown: string }) => <Clipped markdown={markdown} more="Show full proposal" />;

function Clipped({ markdown, more }: { markdown: string; more: string }) {
  const [full, setFull] = useState(false);
  const clip = clipLines(markdown, MAX_LINES, MAX_CHARS);
  return (
    <>
      <Md text={full ? markdown : clip.text} />
      {clip.clipped && (
        <button type="button" className="link" onClick={() => setFull(!full)}>
          {full ? "Show less" : more}
        </button>
      )}
    </>
  );
}

function Review({ review }: { review: NonNullable<ChatMessage["review"]> }) {
  const [open, setOpen] = useState(false);
  const { shown, minors } = splitIssues(review.issues);
  return (
    <>
      <p className="summary">{review.summary}</p>
      <ul className="issues">
        {[...shown, ...(open ? minors : [])].map((i) => <IssueRow key={i.id} issue={i} />)}
      </ul>
      {minors.length > 0 && (
        <button type="button" className="link" onClick={() => setOpen(!open)}>
          {open ? "Show less" : `+${minors.length} more`}
        </button>
      )}
    </>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  return (
    <li>
      <span className={`sev sev-${issue.severity}`}>{issue.severity}</span> <b>{issue.id}</b> {issue.finding}
    </li>
  );
}

const Md = ({ text }: { text: string }) => <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>;

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { IdeaDetail } from "../../../src/ui/types";
import type { MessageBody } from "../api";
import { messageBody, type Draft } from "../lib/composer";
import { browserStorage, clearSent, draftKey, loadDraft, saveDraft, settleSent } from "../lib/drafts";
import { BranchPicker } from "./BranchPicker";
import { ReopenPicker } from "./ReopenPicker";

export interface ComposerHandle { focus(): void }

const ROUND_CHOICES = Array.from({ length: 20 }, (_, i) => i + 1);

/** The reply box under an idea: a note, scenarios, reopened issues and extra rounds in one message. */
export const Composer = forwardRef<ComposerHandle, {
  detail: IdeaDetail;
  /** Resolves once the server has the message; rejects (and the draft stays) on an error. */
  onSend(body: MessageBody): Promise<void>;
  /** Resolves once the server took the stop; rejects on an error. */
  onStop(): Promise<void>;
  onBranch(round: number): void;
}>(function Composer({ detail, onSend, onStop, onBranch }, ref) {
  // The draft is kept in localStorage per idea, so leaving the idea or closing the tab loses nothing.
  const key = draftKey(detail.state.id);
  const [draft, setDraft] = useState<Draft>(() => loadDraft(browserStorage(), key));
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  const active = detail.summary.active;
  const body = messageBody(draft);
  useEffect(() => saveDraft(browserStorage(), key, draft), [key, draft]);
  // One stop per run: a second SIGTERM would force the worker out mid-checkpoint.
  useEffect(() => setStopping(false), [active]);

  const send = () => {
    if (!body || sending) return;
    const sent = draft;
    setSending(true);
    onSend(body).then(
      () => {
        // Clear only what was sent: text typed while the request was in flight stays.
        settleSent(browserStorage(), key, sent);
        setDraft((cur) => clearSent(cur, sent));
        setSending(false);
      },
      () => setSending(false), // the error banner says why; the draft is kept
    );
  };
  const stop = () => {
    if (stopping) return;
    setStopping(true);
    onStop().catch(() => setStopping(false));
  };
  const addScenario = () => {
    if (!draft.text.trim()) return;
    setDraft({ ...draft, text: "", scenarios: [...draft.scenarios, draft.text.trim()] });
    input.current?.focus();
  };

  return (
    <ComposerBox
      value={draft.text}
      onChange={(text) => setDraft({ ...draft, text })}
      onEnter={send}
      inputRef={input}
      placeholder={active ? "Queued for the next revision…" : "Continue this idea…"}
      chips={<>
        {draft.scenarios.map((s, i) => (
          <Chip key={`s${i}`} label={`Scenario: ${s}`} onRemove={() => setDraft({ ...draft, scenarios: draft.scenarios.filter((_, j) => j !== i) })} />
        ))}
        {draft.reopen.map((r) => (
          <Chip key={r} label={`Reopen ${r}`} onRemove={() => setDraft({ ...draft, reopen: draft.reopen.filter((x) => x !== r) })} />
        ))}
      </>}
    >
      <button type="button" className="a" onClick={addScenario} disabled={!draft.text.trim()}
        title="Turn the text into a scenario the proposal must handle">＋ Scenario</button>
      <ReopenPicker issues={detail.issues} selected={draft.reopen} onChange={(reopen) => setDraft({ ...draft, reopen })} />
      <BranchPicker rounds={detail.state.rounds} onPick={onBranch} />
      <select
        className={`a${draft.more !== undefined ? " set" : ""}`} aria-label="Extra rounds"
        value={draft.more ?? ""} onChange={(e) => setDraft({ ...draft, more: e.target.value ? Number(e.target.value) : undefined })}
      >
        <option value="">{active ? "Rounds: +0" : "Rounds: 2"}</option>
        {ROUND_CHOICES.map((n) => <option key={n} value={n}>Rounds: {active ? `+${n}` : n}</option>)}
      </select>
      {active && (
        <button type="button" className="stop" onClick={stop} disabled={stopping} aria-label="Stop"
          title={stopping ? "Stopping…" : "Stop working on this idea"} />
      )}
      <button type="button" className="send" onClick={send} disabled={!body || sending} aria-label="Send">↑</button>
    </ComposerBox>
  );
});

/** The rounded input with chips above and a row of buttons below; Enter sends, Shift+Enter is a newline. */
export function ComposerBox({ value, onChange, onEnter, placeholder, inputRef, chips, children, autoFocus }: {
  value: string;
  onChange(text: string): void;
  onEnter(): void;
  placeholder: string;
  inputRef?: Ref<HTMLTextAreaElement>;
  chips?: ReactNode;
  children: ReactNode;
  autoFocus?: boolean;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onEnter();
    }
  };
  return (
    <div className="comp">
      {chips && <div className="chips">{chips}</div>}
      <textarea
        ref={inputRef} rows={Math.min(8, Math.max(1, value.split("\n").length))} value={value} placeholder={placeholder}
        aria-label={placeholder} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
      />
      <div className="acts">{children}</div>
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove(): void }) {
  return (
    <span className="chip draft" title={label}>
      <span>{label.length > 80 ? `${label.slice(0, 80)}…` : label}</span>
      <button type="button" aria-label={`Remove ${label.slice(0, 40)}`} onClick={onRemove}>×</button>
    </span>
  );
}

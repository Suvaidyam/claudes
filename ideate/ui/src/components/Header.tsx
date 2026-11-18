import { useRef, useState } from "react";
import type { IdeaDetail } from "../../../src/ui/types";
import { plural, scoreChip } from "../lib/format";

export function Header({ detail, onRename }: {
  detail: IdeaDetail;
  /** Rejects on an API error: the edit stays open with what was typed. */
  onRename(title: string): Promise<void>;
}) {
  const s = detail.summary;
  return (
    <header className="top">
      <Title title={s.title} busy={s.active} onRename={onRename} />
      <span className="chip">round {s.rounds} of {detail.maxRounds}</span>
      {s.lastMean !== undefined && <span className="chip">{scoreChip(s.lastMean, s.lastBlockers ?? 0)}</span>}
      <span className="chip">{plural(s.scenarios, "scenario")}</span>
    </header>
  );
}

/** Click to rename: Enter saves, Esc cancels. Not while a worker is on the idea (it owns state.json). */
function Title({ title, busy, onRename }: { title: string; busy: boolean; onRename(t: string): Promise<void> }) {
  const [edit, setEdit] = useState<string>();
  const [saving, setSaving] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const done = () => {
    setEdit(undefined);
    requestAnimationFrame(() => btn.current?.focus());
  };
  const save = () => {
    const t = edit?.trim();
    if (!t || t === title) return done();
    setSaving(true);
    onRename(t).then(() => { setSaving(false); done(); }, () => setSaving(false));
  };

  if (edit !== undefined) {
    return (
      <input
        className="title-edit" aria-label="Idea title" autoFocus value={edit} maxLength={200} disabled={saving}
        onChange={(e) => setEdit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          if (e.key === "Escape") done();
        }}
      />
    );
  }
  return (
    <button
      ref={btn} type="button" className="title" aria-disabled={busy}
      title={busy ? "Rename once the idea has stopped working" : "Rename"}
      onClick={() => { if (!busy) setEdit(title); }}
    >
      {title}
    </button>
  );
}

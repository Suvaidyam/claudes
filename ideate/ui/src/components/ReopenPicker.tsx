import type { PastIssue } from "../../../src/ideas";
import { Popover } from "./Popover";

/** Past review issues grouped by round, with their outcome; ticking one reopens it with the next message. */
export function ReopenPicker({ issues, selected, onChange }: {
  issues: PastIssue[];
  selected: string[];
  onChange(refs: string[]): void;
}) {
  const rounds = [...new Set(issues.map((i) => i.round))];
  const toggle = (ref: string) =>
    onChange(selected.includes(ref) ? selected.filter((r) => r !== ref) : [...selected, ref]);
  return (
    <Popover
      label={selected.length ? `↺ Reopen issue (${selected.length})` : "↺ Reopen issue"}
      title={issues.length ? "Reopen review issues" : "No review issues yet"}
      disabled={!issues.length}
    >
      {(close) => (
        <>
          <div className="pop-list">
            {rounds.map((round) => (
              <fieldset key={round}>
                <legend>Round {round}</legend>
                {issues.filter((i) => i.round === round).map((i) => (
                  <label key={i.ref} className="pick">
                    <input type="checkbox" checked={selected.includes(i.ref)} onChange={() => toggle(i.ref)} />
                    <span>
                      <span className={`sev sev-${i.issue.severity}`}>{i.issue.severity}</span>{" "}
                      <b>{i.reviewer}:{i.issue.id}</b> {i.issue.finding}{" "}
                      <span className="tag">{i.outcome}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          <div className="pop-foot"><button type="button" className="a" onClick={close}>Done</button></div>
        </>
      )}
    </Popover>
  );
}

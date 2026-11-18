import type { RoundRecord } from "../../../src/store";
import { plural } from "../lib/format";
import { Popover } from "./Popover";

/** Pick a reviewed round to branch a new idea from. */
export function BranchPicker({ rounds, onPick, down }: {
  rounds: RoundRecord[];
  onPick(round: number): void;
  down?: boolean;
}) {
  const reviewed = rounds.filter((r) => r.meanScore !== undefined);
  return (
    <Popover
      label="⑂ Branch" down={down}
      title={reviewed.length ? "Branch a new idea from a round" : "Branch once a round has been reviewed"}
      disabled={!reviewed.length}
    >
      {(close) => (
        <div className="pop-list">
          {reviewed.map((r) => (
            <button key={r.round} type="button" className="pick-row" onClick={() => { close(); onPick(r.round); }}>
              Round {r.round} · mean {r.meanScore!.toFixed(1)} · {plural(r.blockers ?? 0, "blocker")}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

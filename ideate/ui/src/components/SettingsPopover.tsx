import type { UiConfig } from "../api";
import { Popover } from "./Popover";

export interface NewIdeaSettings { rounds: number; reviewers: string[] }

/** Rounds (1–20) and reviewers for a new idea; at least one reviewer stays ticked. */
export function SettingsPopover({ config, value, onChange }: {
  config: UiConfig;
  value: NewIdeaSettings;
  onChange(v: NewIdeaSettings): void;
}) {
  const toggle = (r: string) => {
    const on = value.reviewers.includes(r);
    if (on && value.reviewers.length === 1) return;
    onChange({ ...value, reviewers: on ? value.reviewers.filter((x) => x !== r) : config.secondaries.filter((x) => x === r || value.reviewers.includes(x)) });
  };
  return (
    <Popover label={`⚙ ${value.rounds} round${value.rounds === 1 ? "" : "s"} · ${value.reviewers.join(", ")}`} title="Settings for this idea">
      {(close) => (
        <>
          <label className="pick">
            Rounds{" "}
            <input
              type="number" min={1} max={20} value={value.rounds}
              onChange={(e) => onChange({ ...value, rounds: Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
            />
          </label>
          <fieldset>
            <legend>Reviewers ({config.primary} proposes)</legend>
            {config.secondaries.map((r) => (
              <label key={r} className="pick">
                <input type="checkbox" checked={value.reviewers.includes(r)} onChange={() => toggle(r)}
                  disabled={value.reviewers.length === 1 && value.reviewers.includes(r)} />
                {r}
              </label>
            ))}
          </fieldset>
          <div className="pop-foot"><button type="button" className="a" onClick={close}>Done</button></div>
        </>
      )}
    </Popover>
  );
}

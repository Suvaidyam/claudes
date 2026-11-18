import type { RunSummary } from "../../../src/ideas";
import { groupByDate } from "../lib/groupByDate";
import { rowLabel, rowMeta } from "../lib/format";

export function Sidebar({ ideas, selected }: { ideas: RunSummary[]; selected?: string }) {
  return (
    <nav className="sb">
      <a className="new" href="#/">＋ New idea</a>
      {groupByDate(ideas, new Date()).map((g) => (
        <section key={g.label}>
          <div className="grp">{g.label}</div>
          {g.rows.map((r) => <Row key={r.id} row={r} selected={r.id === selected} />)}
        </section>
      ))}
    </nav>
  );
}

function Row({ row, selected }: { row: RunSummary; selected: boolean }) {
  const meta = rowMeta(row);
  const cls = ["it", selected && "sel", row.depth > 0 && "br"].filter(Boolean).join(" ");
  return (
    <a className={cls} href={`#/idea/${encodeURIComponent(row.id)}`} title={row.title}>
      {row.active && <span className="pulse" aria-label="Working" />}
      <span className="label">{row.depth > 0 && "↳ "}{rowLabel(row)}</span>
      {meta && <small> · {meta}</small>}
      {row.interrupted && <span className="tag">Interrupted</span>}
    </a>
  );
}

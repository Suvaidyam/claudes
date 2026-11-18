import type { RunSummary } from "../../../src/ideas";

export type DateLabel = "Today" | "Previous 7 days" | "Older";
export interface DateGroup { label: DateLabel; rows: RunSummary[] }

const DAY = 24 * 60 * 60 * 1000;

function labelFor(createdAt: string, now: Date): DateLabel {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = Date.parse(createdAt);
  if (t >= startOfToday) return "Today";
  if (t >= startOfToday - 7 * DAY) return "Previous 7 days";
  return "Older";
}

/**
 * Sidebar groups by the local creation day of each top-level idea. `rows` come in listRuns order
 * (branches right after their parent), so a branch joins its parent's group whatever its own date.
 */
export function groupByDate(rows: RunSummary[], now: Date): DateGroup[] {
  const groups: DateGroup[] = [
    { label: "Today", rows: [] },
    { label: "Previous 7 days", rows: [] },
    { label: "Older", rows: [] },
  ];
  let current: DateGroup | undefined;
  for (const row of rows) {
    if (row.depth === 0 || !current) current = groups.find((g) => g.label === labelFor(row.createdAt, now));
    current!.rows.push(row);
  }
  return groups.filter((g) => g.rows.length > 0);
}

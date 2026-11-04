// Daily budget: the weekly limit split over the days left until it resets.
//
// Work hours (09–21 local) carry the weight: a weekday counts 1, a Saturday or
// Sunday WEEKEND_WEIGHT, and a day the window only partly covers counts its
// share of those hours. Each day's budget is set once, from the % left at the
// first reading of the day (the snapshot), so a heavy day shrinks the next
// ones and a light day grows them:
//
//   budget(today) = leftAtStart × weight(today) / weight(today … reset)
//   leftToday     = budget(today) − (leftAtStart − leftNow), at least 0
//
// Days are local to the host running the bb server.

export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 21;
export const WEEKEND_WEIGHT = 0.5;

const HOUR_MS = 3_600_000;
/** A weekly window never spans more than this; guards the day loop against bad dates. */
const MAX_DAYS = 14;

export type UsageWindowLike = { label: string; usedPercent: number; resetsAt: string | null };

/** The % left at the first reading of a local day, for one weekly window. */
export type DaySnapshot = {
  /** The weekly window's reset, ISO. */
  resetsAt: string;
  /** Local day, YYYY-MM-DD. */
  day: string;
  leftAtStart: number;
  /** When the snapshot was taken, ISO. */
  at: string;
};

export type TodayBudget = {
  /** Today's share of the weekly limit, % of the week. */
  budgetPercent: number;
  /** What is left of that share, % of the week (0 when over). */
  leftPercent: number;
};

/** The overall weekly limit, not a per-model one ("Fable", "Sonnet", …). */
export const isWeekly = (w: { label: string }) =>
  /week/i.test(w.label) && !/sonnet|opus|fable|haiku/i.test(w.label);

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Weighted work hours in [from, to), in days: a full weekday is 1. */
export function workWeight(from: number, to: number): number {
  if (!(to > from)) return 0;
  let total = 0;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < MAX_DAYS && day.getTime() < to; i++, day.setDate(day.getDate() + 1)) {
    const start = new Date(day).setHours(WORK_START_HOUR, 0, 0, 0);
    const end = new Date(day).setHours(WORK_END_HOUR, 0, 0, 0);
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap <= 0) continue;
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    total += (weekend ? WEEKEND_WEIGHT : 1) * (overlap / (end - start));
  }
  return total;
}

function sameWindow(a: string, b: string): boolean {
  // The provider's reset time wobbles by milliseconds between polls.
  return Math.abs(Date.parse(a) - Date.parse(b)) < HOUR_MS;
}

/**
 * The snapshot to keep after a reading at `now`: the previous one while the
 * day and the window are the same, else a new one from this reading.
 */
export function nextSnapshot(
  previous: DaySnapshot | null,
  weekly: UsageWindowLike,
  now: number,
): DaySnapshot | null {
  if (!weekly.resetsAt || !Number.isFinite(Date.parse(weekly.resetsAt))) return null;
  const day = dayKey(now);
  if (previous && previous.day === day && sameWindow(previous.resetsAt, weekly.resetsAt)) {
    return previous;
  }
  return {
    resetsAt: weekly.resetsAt,
    day,
    leftAtStart: 100 - clamp(weekly.usedPercent, 0, 100),
    at: new Date(now).toISOString(),
  };
}

/**
 * Today's budget from today's snapshot, or null when there is none: no
 * snapshot for today or this window, or no work hours left before the reset
 * or the end of the day.
 */
export function todayBudget(
  snapshot: DaySnapshot | null,
  weekly: UsageWindowLike,
  now: number,
): TodayBudget | null {
  if (!snapshot || !weekly.resetsAt) return null;
  if (snapshot.day !== dayKey(now) || !sameWindow(snapshot.resetsAt, weekly.resetsAt)) return null;
  const at = Date.parse(snapshot.at);
  const reset = Date.parse(weekly.resetsAt);
  const midnight = new Date(at).setHours(24, 0, 0, 0);
  const today = workWeight(at, Math.min(midnight, reset));
  const total = workWeight(at, reset);
  if (!(today > 0) || !(total > 0)) return null;
  const budget = (snapshot.leftAtStart * today) / total;
  const leftNow = 100 - clamp(weekly.usedPercent, 0, 100);
  const used = snapshot.leftAtStart - leftNow;
  return { budgetPercent: budget, leftPercent: clamp(budget - used, 0, budget) };
}

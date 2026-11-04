// Daily budget: the weekly limit split over the days left until it resets.
//
// Work hours (09–21 local) carry the weight. The plan gives each weekday a
// weight (by default a weekday counts 1, a Saturday or Sunday 0.5), and a day
// the window only partly covers counts its share of those hours. Each day's
// budget is set once, from the % left at the first reading of the day (the
// snapshot), so a heavy day shrinks the next ones and a light day grows them:
//
//   budget(today) = leftAtStart × weight(today) / weight(today … reset)
//   leftToday     = budget(today) − (leftAtStart − leftNow), at least 0
//
// A day the plan weighs 0 is a day off: its budget is 0.
//
// Days are local to the host running the bb server.

export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 21;

/** Weight of each weekday, Monday first: how much of the week that day should get. */
export type DayPlan = readonly number[];

/** The largest weight a day can have: twice a plain weekday. */
export const MAX_DAY_WEIGHT = 2;

export const PLAN_PRESETS = {
  even: [1, 1, 1, 1, 1, 1, 1],
  /** The default: Saturday and Sunday count half a weekday. */
  lighter: [1, 1, 1, 1, 1, 0.5, 0.5],
  weekdays: [1, 1, 1, 1, 1, 0, 0],
} as const satisfies Record<string, DayPlan>;

export type PlanPreset = keyof typeof PLAN_PRESETS | "custom";

export const DEFAULT_PLAN: DayPlan = PLAN_PRESETS.lighter;

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

/** A valid plan: seven finite weights from 0 to MAX_DAY_WEIGHT, not all 0. */
export function isDayPlan(value: unknown): value is DayPlan {
  return (
    Array.isArray(value) &&
    value.length === 7 &&
    value.every((w) => typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= MAX_DAY_WEIGHT) &&
    value.some((w) => w > 0)
  );
}

/** The plan stored as JSON ("[1,1,1,1,1,0.5,0.5]"), or null when it isn't one. */
export function parsePlan(json: string): DayPlan | null {
  try {
    const value: unknown = JSON.parse(json);
    return isDayPlan(value) ? value : null;
  } catch {
    return null;
  }
}

/** The preset a plan matches, or "custom". */
export function presetOf(plan: DayPlan): PlanPreset {
  for (const [name, preset] of Object.entries(PLAN_PRESETS)) {
    if (preset.every((w, i) => Math.abs(w - (plan[i] ?? NaN)) < 1e-9)) return name as PlanPreset;
  }
  return "custom";
}

/** Each day's share of a whole week, Monday first, 0–1. */
export function weekShares(plan: DayPlan): number[] {
  const total = plan.reduce((sum, w) => sum + w, 0);
  return plan.map((w) => (total > 0 ? w / total : 0));
}

/** The plan's weight for a local date (JS getDay: 0 is Sunday). */
export function planWeight(plan: DayPlan, weekday: number): number {
  return plan[(weekday + 6) % 7] ?? 0;
}

/** Weighted work hours in [from, to), in days: a full day weighs its plan weight. */
export function workWeight(from: number, to: number, plan: DayPlan = DEFAULT_PLAN): number {
  if (!(to > from)) return 0;
  let total = 0;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < MAX_DAYS && day.getTime() < to; i++, day.setDate(day.getDate() + 1)) {
    const start = new Date(day).setHours(WORK_START_HOUR, 0, 0, 0);
    const end = new Date(day).setHours(WORK_END_HOUR, 0, 0, 0);
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap <= 0) continue;
    total += planWeight(plan, day.getDay()) * (overlap / (end - start));
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
 * or the end of the day. A day off in the plan gets a budget of 0.
 */
export function todayBudget(
  snapshot: DaySnapshot | null,
  weekly: UsageWindowLike,
  now: number,
  plan: DayPlan = DEFAULT_PLAN,
): TodayBudget | null {
  if (!snapshot || !weekly.resetsAt) return null;
  if (snapshot.day !== dayKey(now) || !sameWindow(snapshot.resetsAt, weekly.resetsAt)) return null;
  const at = Date.parse(snapshot.at);
  const reset = Date.parse(weekly.resetsAt);
  const midnight = new Date(at).setHours(24, 0, 0, 0);
  const end = Math.min(midnight, reset);
  // Hours left today before the reset, whatever the plan weighs them.
  if (!(workWeight(at, end, PLAN_PRESETS.even) > 0)) return null;
  const today = workWeight(at, end, plan);
  const total = workWeight(at, reset, plan);
  if (!(total > 0)) return null;
  if (!(today > 0)) return { budgetPercent: 0, leftPercent: 0 };
  const budget = (snapshot.leftAtStart * today) / total;
  const leftNow = 100 - clamp(weekly.usedPercent, 0, 100);
  const used = snapshot.leftAtStart - leftNow;
  return { budgetPercent: budget, leftPercent: clamp(budget - used, 0, budget) };
}

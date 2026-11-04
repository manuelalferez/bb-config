// The plugin's settings as typed preferences, and the pill's colour rules.
//
// Settings live in the plugin's config on the bb server (one set for every
// device). bb stores them as plain values, so the plan is a JSON string there;
// prefsFromSettings reads it back, falling back to the defaults for anything
// missing or invalid, and settingsFromPrefs writes a change.
import { DEFAULT_PLAN, isDayPlan, parsePlan, type DayPlan, type TodayBudget } from "./budget.ts";

export const BATTERY_MODES = ["today", "both", "tightest", "session", "weekly"] as const;
export type BatteryMode = (typeof BATTERY_MODES)[number];

/** The warning's range: % of today's share used. */
export const WARN_MIN = 50;
export const WARN_MAX = 100;

export type Prefs = {
  mode: BatteryMode;
  plan: DayPlan;
  /** Whether the pill warns about today's share. */
  warn: boolean;
  /** % of today's share used at which the pill turns amber. */
  warnAt: number;
  /** Whether the card shows the Today row. */
  todayRow: boolean;
};

/** How bb stores them. */
export type StoredSettings = {
  mode: string;
  plan: string;
  warn: boolean;
  warnAt: number;
  todayRow: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  mode: "today",
  plan: DEFAULT_PLAN,
  warn: true,
  warnAt: 70,
  todayRow: true,
};

export const isBatteryMode = (value: unknown): value is BatteryMode =>
  typeof value === "string" && (BATTERY_MODES as readonly string[]).includes(value);

export const isWarnAt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= WARN_MIN && value <= WARN_MAX;

export function prefsFromSettings(stored: Partial<Record<keyof StoredSettings, unknown>>): Prefs {
  return {
    mode: isBatteryMode(stored.mode) ? stored.mode : DEFAULT_PREFS.mode,
    plan: (typeof stored.plan === "string" ? parsePlan(stored.plan) : null) ?? DEFAULT_PREFS.plan,
    warn: typeof stored.warn === "boolean" ? stored.warn : DEFAULT_PREFS.warn,
    warnAt: isWarnAt(stored.warnAt) ? stored.warnAt : DEFAULT_PREFS.warnAt,
    todayRow: typeof stored.todayRow === "boolean" ? stored.todayRow : DEFAULT_PREFS.todayRow,
  };
}

/** The stored values for a change; invalid fields are left out. */
export function settingsFromPrefs(change: Partial<Prefs>): Partial<StoredSettings> {
  const out: Partial<StoredSettings> = {};
  if (isBatteryMode(change.mode)) out.mode = change.mode;
  if (isDayPlan(change.plan)) out.plan = JSON.stringify(change.plan);
  if (typeof change.warn === "boolean") out.warn = change.warn;
  if (isWarnAt(change.warnAt)) out.warnAt = change.warnAt;
  if (typeof change.todayRow === "boolean") out.todayRow = change.todayRow;
  return out;
}

// --- colour -----------------------------------------------------------------

export type Level = "ok" | "low" | "critical";

/** % of a window left at or below which it turns amber / red. */
export const LOW = 30;
export const CRITICAL = 10;

const RANK: Record<Level, number> = { ok: 0, low: 1, critical: 2 };

export function windowLevel(left: number): Level {
  if (left <= CRITICAL) return "critical";
  if (left <= LOW) return "low";
  return "ok";
}

/**
 * The warning on today's share: amber once `warnAt`% of it is used, red when
 * it is gone. Null when the warning is off or there is no share today.
 */
export function todayLevel(
  today: TodayBudget | null,
  prefs: Pick<Prefs, "warn" | "warnAt">,
): Level | null {
  if (!prefs.warn || !today || !(today.budgetPercent > 0)) return null;
  if (today.leftPercent <= 0) return "critical";
  const usedShare = 1 - today.leftPercent / today.budgetPercent;
  // A hair under the line (a 69.99999% float) still counts as reaching it.
  return usedShare * 100 >= prefs.warnAt - 1e-9 ? "low" : "ok";
}

/** The worse of the window's level and today's warning. */
export function pillLevel(windowLeft: number, today: Level | null): Level {
  const base = windowLevel(windowLeft);
  return today !== null && RANK[today] > RANK[base] ? today : base;
}

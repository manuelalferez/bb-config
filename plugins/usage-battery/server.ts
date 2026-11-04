// bb-plugin-usage-battery — backend: one shared poll of Claude limits.
//
// A background service asks bb.sdk.system.usageLimits() every few minutes and
// keeps the snapshot in memory. Every open window reads that snapshot through
// the `state` RPC, so more tabs add no load on the provider (which rate-limits
// the call when it is polled about once a minute).
//
// It also keeps one snapshot a day (the weekly % left at the first reading of
// the local day) in plugin storage, so the card can show today's budget. The
// daily plan, the warning and what the pill shows are plugin settings: one set
// on this server for every device. The card's settings view writes them
// through the `setConfig` RPC.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isDayPlan, isWeekly, nextSnapshot, todayBudget, type DaySnapshot } from "./budget.ts";
import {
  BATTERY_MODES,
  DEFAULT_PREFS,
  WARN_MAX,
  WARN_MIN,
  prefsFromSettings,
  settingsFromPrefs,
  type Prefs,
} from "./prefs.ts";

/** Normal poll period. */
const POLL_MS = 3 * 60_000;
/** Backoff ceiling after failures. */
const RETRY_MAX_MS = 30 * 60_000;
/**
 * Retries while nothing has loaded yet (the battery is blank meanwhile), then
 * POLL_MS. Never under a minute: the provider rate-limits faster polling.
 */
const STARTUP_RETRY_MS = [60_000, 2 * 60_000];
/** A manual refresh never hits the provider more often than this. */
const MIN_REFRESH_GAP_MS = 30_000;

const CLAUDE_PROVIDER_ID = "claude-code";
/** Key used before bb keyed the answer by provider id. */
const LEGACY_CLAUDE_KEY = "claudeCode";
/** Plugin storage key of today's DaySnapshot. */
const DAY_KEY = "day";

export { BATTERY_MODES, type BatteryMode } from "./prefs.ts";

type UsageLimits = Awaited<
  ReturnType<BbPluginApi["sdk"]["system"]["usageLimits"]>
>;
type ClaudeUsage = UsageLimits[string];

const usageWindow = z.object({
  /** Provider label: "Current session", "Weekly limit", "Fable", … */
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
});

const usageState = z.object({
  status: z.enum([
    "ok",
    "not_installed",
    "unauthenticated",
    "expired",
    "error",
    "unknown",
  ]),
  planLabel: z.string().nullable(),
  accountEmail: z.string().nullable(),
  windows: z.array(usageWindow),
  message: z.string().nullable(),
  /** When the figures in `windows` were last fresh, ISO. */
  okAt: z.string().nullable(),
  mode: z.enum(BATTERY_MODES),
  /** Weight of each weekday, Monday first. */
  plan: z.array(z.number()),
  warn: z.boolean(),
  warnAt: z.number(),
  todayRow: z.boolean(),
  /** Today's share of the weekly limit and what is left of it, or null; a budget of 0 is a day off. */
  today: z
    .object({ budgetPercent: z.number(), leftPercent: z.number() })
    .nullable(),
});

export type UsageState = z.infer<typeof usageState>;
export type UsageWindow = z.infer<typeof usageWindow>;

const configChange = z
  .object({
    mode: z.enum(BATTERY_MODES),
    plan: z.array(z.number()).refine(isDayPlan, "7 weights from 0 to 2, not all 0"),
    warn: z.boolean(),
    warnAt: z.number().int().min(WARN_MIN).max(WARN_MAX),
    todayRow: z.boolean(),
  })
  .partial();

export type ConfigChange = z.infer<typeof configChange>;

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: usageState },
  /** Polls the provider now (throttled) and returns the new snapshot. */
  refresh: { input: z.null(), output: usageState },
  /** Saves settings from the card and returns the snapshot they give. */
  setConfig: { input: configChange, output: usageState },
});

type Snapshot = Omit<UsageState, keyof Prefs | "today"> & { fetchedAt: string | null };

const UNKNOWN: Snapshot = {
  status: "unknown",
  planLabel: null,
  accountEmail: null,
  windows: [],
  message: null,
  okAt: null,
  fetchedAt: null,
};

function claudeUsageOf(usage: UsageLimits): ClaudeUsage | null {
  const byProvider = usage as Record<string, ClaudeUsage | undefined>;
  return byProvider[CLAUDE_PROVIDER_ID] ?? byProvider[LEGACY_CLAUDE_KEY] ?? null;
}

function toSnapshot(claude: ClaudeUsage | null, previous: Snapshot): Snapshot {
  const now = new Date().toISOString();
  if (claude === null) return { ...UNKNOWN, status: "not_installed", fetchedAt: now };
  if (claude.status === "ok") {
    return {
      status: "ok",
      planLabel: claude.planLabel,
      accountEmail: claude.accountEmail,
      windows: claude.windows.map((w) => ({
        label: w.label,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt,
      })),
      message: null,
      okAt: now,
      fetchedAt: now,
    };
  }
  if (claude.status === "error") {
    // A one-off failure keeps the last figures on screen.
    return {
      ...previous,
      status: "error",
      planLabel: claude.planLabel ?? previous.planLabel,
      accountEmail: claude.accountEmail ?? previous.accountEmail,
      message: claude.message,
      fetchedAt: now,
    };
  }
  // Signed out or not installed: the old figures no longer apply.
  return { ...UNKNOWN, status: claude.status, fetchedAt: now };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    mode: {
      type: "select",
      label: "Battery shows",
      description:
        "today = what is left of today's share of the weekly limit; both = today's share and the week; tightest = whichever of the 5-hour session or weekly limit has less left; session = 5-hour window only; weekly = weekly window only.",
      options: [...BATTERY_MODES],
      default: DEFAULT_PREFS.mode,
    },
    plan: {
      type: "string",
      label: "Daily plan",
      description:
        "Weight of each weekday, Monday first, from 0 (a day off) to 2. Each day gets its weight's share of what is left of the week. Default: weekends count half, [1,1,1,1,1,0.5,0.5].",
      experimental_schema: z.string().refine((value) => {
        try {
          return isDayPlan(JSON.parse(value));
        } catch {
          return false;
        }
      }, "A JSON list of 7 weights from 0 to 2, not all 0, e.g. [1,1,1,1,1,0.5,0.5]"),
      default: JSON.stringify(DEFAULT_PREFS.plan),
    },
    warn: {
      type: "boolean",
      label: "Warn about today's share",
      description: "Turn the pill amber once today's share is mostly used, red when it is gone.",
      default: DEFAULT_PREFS.warn,
    },
    warnAt: {
      type: "number",
      label: "Warn at (% of today's share used)",
      experimental_schema: z.number().int().min(WARN_MIN).max(WARN_MAX),
      default: DEFAULT_PREFS.warnAt,
    },
    todayRow: {
      type: "boolean",
      label: "Show the Today row in the card",
      default: DEFAULT_PREFS.todayRow,
    },
  });

  let current: Snapshot = UNKNOWN;
  let inFlight: Promise<Snapshot> | null = null;
  let complaint = "";
  let day: DaySnapshot | null = null;
  let dayLoaded = false;

  /** Starts today's snapshot on the first fresh reading of a new day or window. */
  async function recordDay(): Promise<void> {
    if (!dayLoaded) {
      day = (await bb.storage.kv.get<DaySnapshot>(DAY_KEY).catch(() => undefined)) ?? null;
      dayLoaded = true;
    }
    const weekly = current.status === "ok" ? current.windows.find(isWeekly) : undefined;
    if (!weekly) return;
    const next = nextSnapshot(day, weekly, Date.now());
    if (next === null || next === day) return;
    day = next;
    await bb.storage.kv.set(DAY_KEY, next).catch((error: unknown) => {
      bb.log.warn(`usage battery: couldn't store today's snapshot: ${String(error)}`);
    });
  }

  async function poll(signal?: AbortSignal): Promise<Snapshot> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const usage = await bb.sdk.system.usageLimits({
          providerId: CLAUDE_PROVIDER_ID,
          ...(signal ? { signal } : {}),
        });
        current = toSnapshot(claudeUsageOf(usage), current);
      } catch (error) {
        if (signal?.aborted) return current;
        const message = error instanceof Error ? error.message : String(error);
        current = {
          ...current,
          status: "error",
          message,
          fetchedAt: new Date().toISOString(),
        };
      } finally {
        inFlight = null;
      }
      await recordDay();
      const key = current.status === "ok" ? "" : `${current.status}:${current.message ?? ""}`;
      if (key !== complaint) {
        complaint = key;
        if (key) bb.log.warn(`claude usage: ${key}`);
      }
      return current;
    })();
    return inFlight;
  }

  async function withMode(snapshot: Snapshot): Promise<UsageState> {
    const prefs = prefsFromSettings(await settings.get());
    const { fetchedAt: _, ...rest } = snapshot;
    const weekly = snapshot.windows.find(isWeekly);
    return {
      ...rest,
      ...prefs,
      plan: [...prefs.plan],
      today: weekly ? todayBudget(day, weekly, Date.now(), prefs.plan) : null,
    };
  }

  bb.rpc.register(rpcContract, {
    state: async () => withMode(current.fetchedAt === null ? await poll() : current),
    refresh: async () => {
      const last = current.fetchedAt ? Date.parse(current.fetchedAt) : 0;
      const fresh = Date.now() - last < MIN_REFRESH_GAP_MS;
      return withMode(fresh ? current : await poll());
    },
    setConfig: async (change) => {
      await settings.experimental_set(settingsFromPrefs(change));
      return withMode(current);
    },
  });

  bb.background.service("poll", {
    async start(signal) {
      let delay = POLL_MS;
      let blankFailures = 0;
      while (!signal.aborted) {
        const next = await poll(signal);
        if (next.status === "ok") {
          delay = POLL_MS;
          blankFailures = 0;
        } else if (next.okAt === null) {
          // No figures to fall back on: retry soon instead of backing off.
          delay = STARTUP_RETRY_MS[blankFailures++] ?? POLL_MS;
        } else {
          // Last-known figures stay on screen, so back off.
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });
}

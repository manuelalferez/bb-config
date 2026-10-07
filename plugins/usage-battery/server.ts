// bb-plugin-usage-battery — backend: one shared poll of Claude limits.
//
// A background service asks bb.sdk.system.usageLimits() every few minutes and
// keeps the snapshot in memory. Every open window reads that snapshot through
// the `state` RPC, so more tabs add no load on the provider (which rate-limits
// the call when it is polled about once a minute).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Normal poll period. */
const POLL_MS = 3 * 60_000;
/** Backoff ceiling after failures. */
const RETRY_MAX_MS = 30 * 60_000;
/** A manual refresh never hits the provider more often than this. */
const MIN_REFRESH_GAP_MS = 30_000;

const CLAUDE_PROVIDER_ID = "claude-code";
/** Key used before bb keyed the answer by provider id. */
const LEGACY_CLAUDE_KEY = "claudeCode";

export const BATTERY_MODES = ["tightest", "session", "weekly"] as const;
export type BatteryMode = (typeof BATTERY_MODES)[number];

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
});

export type UsageState = z.infer<typeof usageState>;
export type UsageWindow = z.infer<typeof usageWindow>;

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: usageState },
  /** Polls the provider now (throttled) and returns the new snapshot. */
  refresh: { input: z.null(), output: usageState },
});

type Snapshot = Omit<UsageState, "mode"> & { fetchedAt: string | null };

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
        "tightest = whichever of the 5-hour session or weekly limit has less left; session = 5-hour window only; weekly = weekly window only.",
      options: [...BATTERY_MODES],
      default: "tightest",
    },
  });

  let current: Snapshot = UNKNOWN;
  let inFlight: Promise<Snapshot> | null = null;
  let complaint = "";

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
    const { mode } = await settings.get();
    const { fetchedAt: _, ...rest } = snapshot;
    return {
      ...rest,
      mode: (BATTERY_MODES as readonly string[]).includes(mode)
        ? (mode as BatteryMode)
        : "tightest",
    };
  }

  bb.rpc.register(rpcContract, {
    state: async () => withMode(current.fetchedAt === null ? await poll() : current),
    refresh: async () => {
      const last = current.fetchedAt ? Date.parse(current.fetchedAt) : 0;
      const fresh = Date.now() - last < MIN_REFRESH_GAP_MS;
      return withMode(fresh ? current : await poll());
    },
  });

  bb.background.service("poll", {
    async start(signal) {
      let delay = POLL_MS;
      while (!signal.aborted) {
        const next = await poll(signal);
        delay = next.status === "ok" ? POLL_MS : Math.min(delay * 2, RETRY_MAX_MS);
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

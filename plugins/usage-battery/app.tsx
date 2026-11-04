// bb-plugin-usage-battery — a battery at the right end of the sidebar footer.
//
// The battery is a pill showing how much of the Claude subscription limit is
// LEFT and the time until that window resets ("● 84% · 50m"). In the default
// `today` mode the percentage is what is left of today's share of the weekly
// limit (see budget.ts), and the reset is the weekly one. Hovering it
// opens a footer disclosure with every window and its reset time; clicking
// pins it open. A gear in the card opens its settings view: the daily plan as
// seven bars to drag, the warning on today's share, and what the pill shows.
// Settings are saved on the bb server, so every device shows the same.
//
// bb renders footer items as icons only, so the battery is drawn by an app
// overlay that portals its own <li> into the footer row, right after bb's
// spacer (the right end of the row). The plugin's host icon is the anchor for
// finding that row; it is hidden while the battery stands in for it. bb's
// footer markup is not a versioned API: when the anchor can't be found, the
// plain host icon stays and still opens the same disclosure.
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  useRpc,
  type ExperimentalSidebarFooterDisclosureController,
  type ExperimentalSidebarFooterDisclosureProps,
  type PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import type { ConfigChange, UsageState, UsageWindow, rpcContract } from "./server";
import {
  MAX_DAY_WEIGHT,
  PLAN_PRESETS,
  isWeekly,
  presetOf,
  weekShares,
  type DayPlan,
  type PlanPreset,
} from "./budget.ts";
import {
  WARN_MAX,
  WARN_MIN,
  pillLevel,
  todayLevel,
  windowLevel,
  type BatteryMode,
} from "./prefs.ts";
import "./app.css";

const PLUGIN_ID = "usage-battery";
const ITEM_ID = "battery";
const ANCHOR_SELECTOR = `[data-testid="plugin-sidebar-footer-item-${PLUGIN_ID}-${ITEM_ID}"]`;
const ANCHOR_ATTRIBUTE = "data-usage-battery-anchor";

/** The backend shares one poll; reading its snapshot often is cheap. */
const READ_MS = 30_000;
const CLOCK_MS = 30_000;
/** Hover delays: a pass over the battery doesn't open the card, and moving
 * from the battery to the card doesn't close it. */
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 300;
/** A settings edit is saved once the controls rest this long. */
const SAVE_DELAY_MS = 400;

let disclosure: ExperimentalSidebarFooterDisclosureController | null = null;

// --- data -------------------------------------------------------------------

type UsageClient = PluginRpcClient<typeof rpcContract>;
type UsageSnapshot = { state: UsageState | null; now: number };

// One snapshot shared by every useUsage(), so a refresh from the card also
// updates the footer battery. The timers run once while anyone is subscribed.
const usage = {
  snapshot: { state: null, now: Date.now() } as UsageSnapshot,
  listeners: new Set<() => void>(),
  rpc: null as UsageClient | null,
  generation: 0,
  refreshing: 0,
  stop: null as (() => void) | null,
};

function publish(next: Partial<UsageSnapshot>) {
  usage.snapshot = { ...usage.snapshot, ...next };
  for (const listener of usage.listeners) listener();
}

function loadUsage(method: "state" | "refresh") {
  const rpc = usage.rpc;
  if (!rpc) return;
  // A read during a refresh would return the figures the refresh replaces.
  if (method === "state" && usage.refreshing > 0) return;
  const id = ++usage.generation;
  if (method === "refresh") usage.refreshing++;
  void rpc
    .call(method, null)
    .then(
      (result) => {
        if (id !== usage.generation) return;
        publish({ state: result, now: Date.now() });
      },
      () => {},
    )
    .finally(() => {
      if (method === "refresh") usage.refreshing--;
    });
}

function startUsage(): () => void {
  loadUsage("state");
  const read = window.setInterval(() => loadUsage("state"), READ_MS);
  const clock = window.setInterval(() => publish({ now: Date.now() }), CLOCK_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") loadUsage("state");
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(read);
    window.clearInterval(clock);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function subscribeUsage(listener: () => void): () => void {
  usage.listeners.add(listener);
  usage.stop ??= startUsage();
  return () => {
    usage.listeners.delete(listener);
    if (usage.listeners.size > 0) return;
    usage.stop?.();
    usage.stop = null;
  };
}

const refreshUsage = () => loadUsage("refresh");

/** Saves settings; the answer replaces the snapshot, so the pill follows at once. */
function saveConfig(change: ConfigChange): Promise<void> {
  const rpc = usage.rpc;
  if (!rpc) return Promise.resolve();
  const id = ++usage.generation;
  return rpc.call("setConfig", change).then(
    (result) => {
      if (id === usage.generation) publish({ state: result, now: Date.now() });
    },
    // Refused (an invalid value): show what is stored.
    () => loadUsage("state"),
  );
}

function useUsage() {
  usage.rpc = useRpc<typeof rpcContract>();
  const { state, now } = useSyncExternalStore(subscribeUsage, () => usage.snapshot);
  return { state, now, refresh: refreshUsage };
}

// --- hover -----------------------------------------------------------------

// A card the hover opened closes shortly after the mouse leaves both the
// battery and the card. A click pins it, and a card opened any other way
// (a click, or bb's own icon when the battery can't be placed) starts pinned.
const hover = {
  open: false,
  pinned: false,
  viaHover: false,
  timer: null as number | null,
};

function cancelHover() {
  if (hover.timer !== null) window.clearTimeout(hover.timer);
  hover.timer = null;
}

function hoverIn(event: PointerEvent) {
  if (event.pointerType !== "mouse") return;
  cancelHover();
  if (hover.open) return;
  hover.timer = window.setTimeout(() => {
    hover.viaHover = true;
    disclosure?.open();
  }, HOVER_OPEN_MS);
}

function hoverOut(event: PointerEvent) {
  if (event.pointerType !== "mouse") return;
  cancelHover();
  if (hover.open && !hover.pinned) {
    hover.timer = window.setTimeout(() => disclosure?.close(), HOVER_CLOSE_MS);
  }
}

function clickBattery() {
  cancelHover();
  // A click on a card the hover opened keeps it open instead of closing it.
  if (hover.open && !hover.pinned) {
    hover.pinned = true;
    return;
  }
  hover.viaHover = false;
  disclosure?.toggle();
}

// --- usage model ------------------------------------------------------------

const isSession = (w: UsageWindow) => /session|5.?h/i.test(w.label);

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** The window the battery reports, by the chosen mode. */
function batteryWindow(windows: UsageWindow[], mode: BatteryMode): UsageWindow | null {
  const session = windows.find(isSession) ?? null;
  const weekly = windows.find(isWeekly) ?? null;
  if (mode === "session") return session ?? weekly;
  // `today` and `both` fall back to the weekly window the budget comes from.
  if (mode === "weekly" || mode === "today" || mode === "both") return weekly ?? session;
  const candidates = [session, weekly].filter((w): w is UsageWindow => w !== null);
  if (candidates.length === 0) return windows[0] ?? null;
  return candidates.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
}

function shortLabel(w: UsageWindow): string {
  if (isSession(w)) return "5h";
  if (isWeekly(w)) return "7d";
  return `7d · ${w.label.replace(/weekly|limit/gi, "").trim() || w.label}`;
}

function resetIn(resetsAt: string | null, now: number): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// --- battery ----------------------------------------------------------------

function useFooterSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const item = document.createElement("li");
    item.className = "usage-battery-footer";
    let anchor: Element | null = null;
    let frame: number | null = null;

    const setAnchor = (next: Element | null) => {
      if (next === anchor) return;
      anchor?.removeAttribute(ANCHOR_ATTRIBUTE);
      next?.setAttribute(ANCHOR_ATTRIBUTE, "");
      anchor = next;
    };

    // Right after bb's spacer <li aria-hidden>, i.e. the right end of the row.
    const place = (row: Element) => {
      const spacer = Array.from(row.children).find(
        (child) => child.tagName === "LI" && child.getAttribute("aria-hidden") === "true",
      );
      if (!spacer) {
        if (item.parentElement !== row || item.nextElementSibling !== null) row.append(item);
      } else if (item.previousElementSibling !== spacer) {
        spacer.after(item);
      }
    };

    const attach = () => {
      frame = null;
      const row = anchor?.isConnected ? anchor.parentElement : null;
      if (row && item.parentElement === row) {
        place(row);
        return;
      }
      const next = document.querySelector(ANCHOR_SELECTOR)?.closest("li[data-footer-item]") ?? null;
      const nextRow = next?.parentElement ?? null;
      if (!next || !nextRow) {
        setAnchor(null);
        item.remove();
        setSlot(null);
        return;
      }
      setAnchor(next);
      place(nextRow);
      setSlot(item);
    };

    const observer = new MutationObserver(() => {
      frame ??= window.requestAnimationFrame(attach);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    attach();

    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      setAnchor(null);
      item.remove();
      setSlot(null);
    };
  }, []);

  return slot;
}

function FooterBattery() {
  const { state, now } = useUsage();
  const slot = useFooterSlot();
  if (slot === null) return null;

  const window_ = state ? batteryWindow(state.windows, state.mode) : null;
  const windowLeft = window_ ? 100 - clampPercent(window_.usedPercent) : null;
  // `today` and `both` show today's share; a day off shows the week instead.
  const showsToday = state?.mode === "today" || state?.mode === "both";
  const today =
    showsToday && window_ && isWeekly(window_) && state?.today && state.today.budgetPercent > 0
      ? state.today
      : null;
  const todayLeft = today ? clampPercent(today.leftPercent) : null;
  const both = state?.mode === "both" && todayLeft !== null;
  const remaining = todayLeft ?? windowLeft;
  // The window's level, raised by the warning on today's share.
  const level =
    windowLeft === null ? "unknown" : pillLevel(windowLeft, state ? todayLevel(today, state) : null);
  const stale = state !== null && state.status !== "ok";
  const reset = window_ ? resetIn(window_.resetsAt, now) : "";
  const what = both ? "today / week" : today ? "today" : window_ ? shortLabel(window_) : "";
  const amount = both ? `${todayLeft}% / ${windowLeft}%` : `${remaining}%`;
  const title =
    remaining === null
      ? "Claude usage: unavailable"
      : `Claude ${what}: ${amount} left${reset ? ` · resets in ${reset}` : ""}${stale ? " (last known)" : ""}`;

  return createPortal(
    <button
      type="button"
      className="usage-battery-button"
      data-level={level}
      data-stale={stale || undefined}
      aria-label={title}
      onClick={clickBattery}
      onPointerEnter={hoverIn}
      onPointerLeave={hoverOut}
    >
      <span className="usage-battery-pill">
        <span className="usage-battery-dot" />
        <span className="usage-battery-percent">{remaining === null ? "–" : `${remaining}%`}</span>
        {both ? <span className="usage-battery-reset">/ {windowLeft}%</span> : null}
        {reset ? <span className="usage-battery-reset">· {reset}</span> : null}
      </span>
    </button>,
    slot,
  );
}

// --- disclosure -------------------------------------------------------------

function UsageDetails({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const { state, now, refresh } = useUsage();
  const [view, setView] = useState<"usage" | "settings">("usage");

  // Opening the card asks for fresh numbers (the backend throttles this).
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    hover.open = true;
    hover.pinned = !hover.viaHover;
    hover.viaHover = false;
    return () => {
      cancelHover();
      hover.open = false;
      hover.pinned = false;
    };
  }, []);

  const openSettings = () => {
    // Settings take a while to change: the card stays open when the mouse leaves.
    cancelHover();
    hover.pinned = true;
    setView("settings");
  };

  // Laid out like bb's built-in Provider usage card: a 36px header with a
  // divider, then the account line and one 20px row per window, all at 10px.
  return (
    <div
      className="usage-battery-card"
      data-view={view}
      onPointerEnter={hoverIn}
      onPointerLeave={hoverOut}
    >
      <div className="usage-battery-card-head">
        {view === "settings" ? (
          <>
            <button type="button" className="usage-battery-back" onClick={() => setView("usage")}>
              <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m15 18-6-6 6-6" />
              </svg>
              Usage left
            </button>
            <span className="usage-battery-title usage-battery-title-center">Settings</span>
          </>
        ) : (
          <>
            <span className="usage-battery-title">Usage left</span>
            <button
              type="button"
              className="usage-battery-close"
              aria-label="Settings"
              title="Settings"
              onClick={openSettings}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </>
        )}
        <button type="button" className="usage-battery-close" aria-label="Close" onClick={dismiss}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="usage-battery-card-body">
        {view === "settings" ? (
          state === null ? (
            <p className="usage-battery-note">Loading…</p>
          ) : (
            <UsageSettings state={state} />
          )
        ) : (
          <UsageRows state={state} now={now} />
        )}
      </div>
    </div>
  );
}

function UsageRows({ state, now }: { state: UsageState | null; now: number }) {
  return (
    <>
      {state?.accountEmail || state?.planLabel ? (
        <div className="usage-battery-account">
          <span className="usage-battery-email">{state.accountEmail ?? "Claude"}</span>
          {state.planLabel ? <span className="usage-battery-plan">{state.planLabel}</span> : null}
        </div>
      ) : null}
      {state === null ? (
        <p className="usage-battery-note">Loading…</p>
      ) : state.windows.length === 0 ? (
        <p className="usage-battery-note">{statusText(state)}</p>
      ) : (
        <>
          <div className="usage-battery-rows">
            {state.todayRow && state.today ? <TodayRow today={state.today} /> : null}
            {state.windows.map((w) => {
              const used = clampPercent(w.usedPercent);
              const left = 100 - used;
              return (
                <div key={w.label} className="usage-battery-row" data-level={windowLevel(left)}>
                  <span className="usage-battery-row-label">{shortLabel(w)}</span>
                  <span className="usage-battery-bar">
                    <span style={{ width: `${left}%` }} />
                  </span>
                  <span className="usage-battery-row-value">{left}%</span>
                  <span className="usage-battery-row-reset">{resetIn(w.resetsAt, now)}</span>
                </div>
              );
            })}
          </div>
          {state.status !== "ok" ? <p className="usage-battery-note">{statusText(state)}</p> : null}
        </>
      )}
    </>
  );
}

/** Today's share of the weekly limit: the bar empties as the day's share is used. */
function TodayRow({ today }: { today: NonNullable<UsageState["today"]> }) {
  if (!(today.budgetPercent > 0)) {
    return (
      <div className="usage-battery-row usage-battery-row-today">
        <span className="usage-battery-row-label">Today</span>
        <span className="usage-battery-bar" />
        <span className="usage-battery-row-value usage-battery-row-value-wide">day off</span>
      </div>
    );
  }
  const left = clampPercent(today.leftPercent);
  const share = (today.leftPercent / today.budgetPercent) * 100;
  return (
    <div className="usage-battery-row usage-battery-row-today">
      <span className="usage-battery-row-label">Today</span>
      <span className="usage-battery-bar">
        <span style={{ width: `${Math.max(0, Math.min(100, share))}%` }} />
      </span>
      <span className="usage-battery-row-value usage-battery-row-value-wide">{left}% left</span>
    </div>
  );
}

// --- settings ---------------------------------------------------------------

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const PRESET_LABELS: Record<PlanPreset, string> = {
  even: "Even",
  lighter: "Lighter weekends",
  weekdays: "Weekdays only",
  custom: "Custom",
};
const PILL_MODES: { mode: BatteryMode; label: string }[] = [
  { mode: "today", label: "Today" },
  { mode: "weekly", label: "Week" },
  { mode: "both", label: "Both" },
];
const WEIGHT_STEP = 0.1;

/** To the nearest 0.1, without float noise (1.2, not 1.2000000000000002). */
const roundWeight = (w: number) =>
  Math.max(0, Math.min(MAX_DAY_WEIGHT, Math.round(w * 10) / 10));
const weightLabel = (w: number) =>
  w === 0 ? "off" : w === 0.5 ? "½×" : `${Number(w.toFixed(1))}×`;

type SettingsDraft = Pick<UsageState, "mode" | "warn" | "warnAt" | "todayRow"> & { plan: DayPlan };

/**
 * The stored settings with unsaved edits on top. Edits are saved once the
 * controls rest for SAVE_DELAY_MS, and when the view closes.
 */
function useSettingsDraft(state: UsageState) {
  const [pending, setPending] = useState<ConfigChange>({});
  const pendingRef = useRef<ConfigChange>({});
  const timer = useRef<number | null>(null);

  const flush = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const change = pendingRef.current;
    if (Object.keys(change).length === 0) return;
    void saveConfig(change).finally(() => {
      // Later edits stay pending for their own save.
      if (pendingRef.current === change) {
        pendingRef.current = {};
        setPending({});
      }
    });
  };

  const edit = (change: ConfigChange) => {
    pendingRef.current = { ...pendingRef.current, ...change };
    setPending(pendingRef.current);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };

  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  const draft: SettingsDraft = {
    mode: pending.mode ?? state.mode,
    plan: pending.plan ?? state.plan,
    warn: pending.warn ?? state.warn,
    warnAt: pending.warnAt ?? state.warnAt,
    todayRow: pending.todayRow ?? state.todayRow,
  };
  return { draft, edit };
}

function UsageSettings({ state }: { state: UsageState }) {
  const { draft, edit } = useSettingsDraft(state);
  const preset = presetOf(draft.plan);
  const today = state.today;

  return (
    <div className="usage-battery-settings">
      <section className="usage-battery-set-sec" aria-labelledby="usage-battery-plan-title">
        <div className="usage-battery-set-head">
          <span id="usage-battery-plan-title">Daily plan</span>
          <small>
            {!today ? (
              "share of the week"
            ) : today.budgetPercent > 0 ? (
              <>
                Today <b>{Number(today.budgetPercent.toFixed(1))}%</b> ·{" "}
                {clampPercent(today.leftPercent)}% left
              </>
            ) : (
              "Today is a day off"
            )}
          </small>
        </div>
        <div className="usage-battery-chips" role="group" aria-label="Plan preset">
          {(Object.keys(PRESET_LABELS) as PlanPreset[]).map((name) => (
            <button
              key={name}
              type="button"
              className="usage-battery-chip"
              aria-pressed={preset === name}
              onClick={() => {
                if (name !== "custom") edit({ plan: [...PLAN_PRESETS[name]] });
              }}
            >
              {PRESET_LABELS[name]}
            </button>
          ))}
        </div>
        <PlanBars plan={draft.plan} onChange={(plan) => edit({ plan })} />
      </section>

      {/* One line each, so the whole view fits bb's 320px card without scrolling. */}
      <section className="usage-battery-set-sec usage-battery-set-line" aria-labelledby="usage-battery-warn">
        <span id="usage-battery-warn" className="usage-battery-set-label">Warn me</span>
        {draft.warn ? (
          <>
            <input
              type="range"
              min={WARN_MIN}
              max={WARN_MAX}
              step={5}
              value={draft.warnAt}
              aria-label="Warn when this % of today's share is used"
              onChange={(event) => edit({ warnAt: Number(event.currentTarget.value) })}
            />
            <output>{draft.warnAt}%</output>
          </>
        ) : (
          <span className="usage-battery-set-off">off</span>
        )}
        <Switch
          checked={draft.warn}
          label="Warn about today's share"
          onChange={(warn) => edit({ warn })}
        />
      </section>

      <section className="usage-battery-set-sec usage-battery-set-line" aria-labelledby="usage-battery-pill">
        <span id="usage-battery-pill" className="usage-battery-set-label" aria-label="Pill shows">
          Pill
        </span>
        <div className="usage-battery-seg" role="group" aria-labelledby="usage-battery-pill">
          {PILL_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              aria-pressed={draft.mode === mode}
              onClick={() => edit({ mode })}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="usage-battery-set-pair">
          <span className="usage-battery-set-label">Today row</span>
          <Switch
            checked={draft.todayRow}
            label="Show the Today row in the card"
            onChange={(todayRow) => edit({ todayRow })}
          />
        </span>
      </section>

      <p className="usage-battery-hint usage-battery-set-foot">
        Saved on the bb server, for every device.
      </p>
    </div>
  );
}

function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="usage-battery-switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    />
  );
}

/** Seven bars, Monday first: drag a bar (or use the arrow keys) to set that day's weight. */
function PlanBars({ plan, onChange }: { plan: DayPlan; onChange: (plan: number[]) => void }) {
  const shares = weekShares(plan);
  const todayIndex = (new Date().getDay() + 6) % 7;

  const setDay = (index: number, weight: number) => {
    const next = [...plan];
    next[index] = roundWeight(weight);
    // A plan needs at least one day: the last one can't go to 0.
    if (!next.some((w) => w > 0)) return;
    if (next[index] !== plan[index]) onChange(next);
  };

  const fromPointer = (index: number, event: PointerEvent<HTMLElement>) => {
    const track = event.currentTarget.querySelector<HTMLElement>(".usage-battery-day-track");
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const fraction = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    setDay(index, fraction * MAX_DAY_WEIGHT);
  };

  const onKey = (index: number, event: KeyboardEvent<HTMLElement>) => {
    const step: Record<string, number> = {
      ArrowUp: WEIGHT_STEP,
      ArrowRight: WEIGHT_STEP,
      ArrowDown: -WEIGHT_STEP,
      ArrowLeft: -WEIGHT_STEP,
      PageUp: 0.5,
      PageDown: -0.5,
    };
    const weight = plan[index] ?? 0;
    if (event.key in step) setDay(index, weight + step[event.key]!);
    else if (event.key === "Home") setDay(index, 0);
    else if (event.key === "End") setDay(index, MAX_DAY_WEIGHT);
    else return;
    event.preventDefault();
  };

  return (
    <div className="usage-battery-days">
      {DAYS.map((day, index) => {
        const weight = plan[index] ?? 0;
        const share = Math.round((shares[index] ?? 0) * 100);
        return (
          <div
            key={day}
            className="usage-battery-day"
            data-today={index === todayIndex || undefined}
            role="slider"
            tabIndex={0}
            aria-label={`${day} weight`}
            aria-valuemin={0}
            aria-valuemax={MAX_DAY_WEIGHT}
            aria-valuenow={weight}
            aria-valuetext={`${weightLabel(weight)}, ${share}% of the week`}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              fromPointer(index, event);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(index, event);
            }}
            onKeyDown={(event) => onKey(index, event)}
          >
            <span className="usage-battery-day-share">{share}%</span>
            <span className="usage-battery-day-track">
              <span style={{ height: `${(weight / MAX_DAY_WEIGHT) * 100}%` }} />
            </span>
            <span className="usage-battery-day-label">{day}</span>
            <span className="usage-battery-day-weight">{weightLabel(weight)}</span>
          </div>
        );
      })}
    </div>
  );
}

function statusText(state: UsageState): string {
  switch (state.status) {
    case "not_installed":
      return "Claude Code isn't set up on this host.";
    case "unauthenticated":
    case "expired":
      return "Sign in to Claude Code to see usage.";
    case "error":
      return `Couldn't refresh${state.okAt ? " (showing last known)" : ""}: ${state.message ?? "unknown error"}`;
    default:
      return "Waiting for usage…";
  }
}

export default definePluginApp((app) => {
  disclosure = app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: ITEM_ID,
    label: "Claude usage",
    icon: "BatteryMedium",
    component: UsageDetails,
  });
  app.slots.experimental_appOverlay({
    id: "footer-battery",
    component: FooterBattery,
  });
});

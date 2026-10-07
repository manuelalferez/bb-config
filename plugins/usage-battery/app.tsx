// bb-plugin-usage-battery — a battery at the right end of the sidebar footer.
//
// The battery shows how much of the Claude subscription limit is LEFT, like a
// laptop battery: full at 0% used, empty at 100%. Clicking it toggles a
// footer disclosure with every window and its reset time.
//
// bb renders footer items as icons only, so the battery is drawn by an app
// overlay that portals its own <li> into the footer row, right after bb's
// spacer (the right end of the row). The plugin's host icon is the anchor for
// finding that row; it is hidden while the battery stands in for it. bb's
// footer markup is not a versioned API: when the anchor can't be found, the
// plain host icon stays and still opens the same disclosure.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  useRpc,
  type ExperimentalSidebarFooterDisclosureController,
  type ExperimentalSidebarFooterDisclosureProps,
} from "@get-bb/plugin-sdk/app";
import type { BatteryMode, UsageState, UsageWindow, rpcContract } from "./server";
import "./app.css";

const PLUGIN_ID = "usage-battery";
const ITEM_ID = "battery";
const ANCHOR_SELECTOR = `[data-testid="plugin-sidebar-footer-item-${PLUGIN_ID}-${ITEM_ID}"]`;
const ANCHOR_ATTRIBUTE = "data-usage-battery-anchor";

/** The backend shares one poll; reading its snapshot often is cheap. */
const READ_MS = 30_000;
const CLOCK_MS = 30_000;
/** Remaining % at or below which the battery turns amber / red. */
const LOW = 30;
const CRITICAL = 10;

let disclosure: ExperimentalSidebarFooterDisclosureController | null = null;

// --- data -------------------------------------------------------------------

function useUsage() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<UsageState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);

  const load = useCallback(
    (method: "state" | "refresh") => {
      const id = ++generation.current;
      void rpc.call(method, null).then(
        (result) => {
          if (id !== generation.current) return;
          setState(result);
          setNow(Date.now());
        },
        () => {},
      );
    },
    [rpc],
  );

  useEffect(() => {
    load("state");
    const read = window.setInterval(() => load("state"), READ_MS);
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load("state");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      generation.current++;
      window.clearInterval(read);
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return { state, now, refresh: useCallback(() => load("refresh"), [load]) };
}

// --- usage model ------------------------------------------------------------

const isSession = (w: UsageWindow) => /session|5.?h/i.test(w.label);
const isWeekly = (w: UsageWindow) =>
  /week/i.test(w.label) && !/sonnet|opus|fable|haiku/i.test(w.label);

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** The window the battery reports, by the chosen mode. */
function batteryWindow(windows: UsageWindow[], mode: BatteryMode): UsageWindow | null {
  const session = windows.find(isSession) ?? null;
  const weekly = windows.find(isWeekly) ?? null;
  if (mode === "session") return session ?? weekly;
  if (mode === "weekly") return weekly ?? session;
  const candidates = [session, weekly].filter((w): w is UsageWindow => w !== null);
  if (candidates.length === 0) return windows[0] ?? null;
  return candidates.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
}

function levelOf(remaining: number): "ok" | "low" | "critical" {
  if (remaining <= CRITICAL) return "critical";
  if (remaining <= LOW) return "low";
  return "ok";
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

function BatteryIcon({ remaining }: { remaining: number | null }) {
  // Sized and stroked like bb's 16px footer icons: a 17×9 body plus a nub,
  // with the fill 1px inside the outline.
  const inner = 13.4;
  const fill = remaining === null ? 0 : Math.max(remaining > 0 ? 1 : 0, (inner * remaining) / 100);
  return (
    <svg className="usage-battery-icon" width="20" height="10" viewBox="0 0 20 10" aria-hidden="true">
      <rect className="usage-battery-shell" x="0.67" y="0.67" width="16.66" height="8.66" rx="2.2" />
      <path className="usage-battery-nub" d="M18.4 3.4 a1.2 1.6 0 0 1 0 3.2 z" />
      <rect className="usage-battery-fill" x="2.3" y="2.3" width={fill} height="5.4" rx="1" />
    </svg>
  );
}

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
  const remaining = window_ ? 100 - clampPercent(window_.usedPercent) : null;
  const level = remaining === null ? "unknown" : levelOf(remaining);
  const stale = state !== null && state.status !== "ok";
  const reset = window_ ? resetIn(window_.resetsAt, now) : "";
  const title =
    remaining === null
      ? "Claude usage: unavailable"
      : `Claude ${shortLabel(window_!)}: ${remaining}% left${reset ? ` · resets in ${reset}` : ""}${stale ? " (last known)" : ""}`;

  return createPortal(
    <button
      type="button"
      className="usage-battery-button"
      data-level={level}
      data-stale={stale || undefined}
      title={title}
      aria-label={title}
      onClick={() => disclosure?.toggle()}
    >
      <span className="usage-battery-percent">{remaining === null ? "–" : `${remaining}%`}</span>
      <BatteryIcon remaining={remaining} />
    </button>,
    slot,
  );
}

// --- disclosure -------------------------------------------------------------

function UsageDetails({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const { state, now, refresh } = useUsage();

  // Opening the card asks for fresh numbers (the backend throttles this).
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Laid out like bb's built-in Provider usage card: a 36px header with a
  // divider, then the account line and one 20px row per window, all at 10px.
  return (
    <div className="usage-battery-card">
      <div className="usage-battery-card-head">
        <span className="usage-battery-title">Usage left</span>
        <button type="button" className="usage-battery-close" aria-label="Close" onClick={dismiss}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="usage-battery-card-body">
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
              {state.windows.map((w) => {
                const used = clampPercent(w.usedPercent);
                const left = 100 - used;
                return (
                  <div key={w.label} className="usage-battery-row" data-level={levelOf(left)}>
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
      </div>
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

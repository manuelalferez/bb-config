// Run with: npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PREFS,
  pillLevel,
  prefsFromSettings,
  settingsFromPrefs,
  todayLevel,
  windowLevel,
  type Prefs,
} from "./prefs.ts";

const on = { warn: true, warnAt: 70 };
/** Today's share of 16% of the week with `used` of it gone. */
const today = (used: number) => ({ budgetPercent: 16, leftPercent: Math.max(0, 16 - used) });

test("config: the defaults keep today's behaviour", () => {
  assert.deepEqual(prefsFromSettings({}), DEFAULT_PREFS);
  assert.equal(DEFAULT_PREFS.mode, "today");
  assert.deepEqual(DEFAULT_PREFS.plan, [1, 1, 1, 1, 1, 0.5, 0.5]);
});

test("config: round trip through what bb stores", () => {
  const prefs: Prefs = {
    mode: "both",
    plan: [1, 1, 2, 1, 1, 0, 0.5],
    warn: false,
    warnAt: 85,
    todayRow: false,
  };
  const stored = settingsFromPrefs(prefs);
  assert.equal(stored.plan, "[1,1,2,1,1,0,0.5]");
  assert.deepEqual(prefsFromSettings(stored), prefs);
});

test("config: existing modes still read back", () => {
  for (const mode of ["today", "tightest", "session", "weekly", "both"] as const) {
    assert.equal(prefsFromSettings({ mode }).mode, mode);
  }
});

test("config: invalid stored values fall back to the defaults", () => {
  const prefs = prefsFromSettings({ mode: "loud", plan: "[1,2]", warn: "yes", warnAt: 20, todayRow: 1 });
  assert.deepEqual(prefs, DEFAULT_PREFS);
});

test("config: a change writes only its valid fields", () => {
  assert.deepEqual(settingsFromPrefs({ warnAt: 75 }), { warnAt: 75 });
  assert.deepEqual(settingsFromPrefs({ plan: [0, 0, 0, 0, 0, 0, 0], warnAt: 101 }), {});
});

test("warning: amber at the chosen % of today's share used, red when it is gone", () => {
  assert.equal(todayLevel(today(3), on), "ok"); // 19% used
  assert.equal(todayLevel(today(11), on), "ok"); // 69% used
  assert.equal(todayLevel(today(11.2), on), "low"); // 70% used
  assert.equal(todayLevel(today(15.9), on), "low");
  assert.equal(todayLevel(today(16), on), "critical");
  assert.equal(todayLevel(today(20), on), "critical");
  assert.equal(todayLevel(today(13.6), { warn: true, warnAt: 85 }), "low");
  assert.equal(todayLevel(today(13.5), { warn: true, warnAt: 85 }), "ok");
});

test("warning: off, a day off, or no share today leave the pill to the week", () => {
  assert.equal(todayLevel(today(20), { warn: false, warnAt: 70 }), null);
  assert.equal(todayLevel({ budgetPercent: 0, leftPercent: 0 }, on), null);
  assert.equal(todayLevel(null, on), null);
});

test("pill colour: the worse of the week and today's warning", () => {
  assert.equal(windowLevel(93), "ok");
  assert.equal(windowLevel(30), "low");
  assert.equal(windowLevel(10), "critical");
  assert.equal(pillLevel(93, null), "ok");
  assert.equal(pillLevel(93, "low"), "low");
  assert.equal(pillLevel(93, "critical"), "critical");
  assert.equal(pillLevel(25, "ok"), "low");
  assert.equal(pillLevel(8, "low"), "critical");
});

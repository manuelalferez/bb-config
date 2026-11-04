// Run with: npm test (TZ=Europe/Madrid, so local days match the examples).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PLAN,
  PLAN_PRESETS,
  dayKey,
  isDayPlan,
  nextSnapshot,
  parsePlan,
  presetOf,
  todayBudget,
  weekShares,
  workWeight,
  type DaySnapshot,
} from "./budget.ts";

// The real window on 4 Nov 2026: resets Tue 10 Nov 22:00 Madrid.
const RESET = "2026-11-10T21:00:00.101Z";
const local = (iso: string) => new Date(iso).getTime(); // no Z: local time
const weekly = (usedPercent: number, resetsAt: string | null = RESET) => ({
  label: "Weekly limit",
  usedPercent,
  resetsAt,
});
const snap = (at: string, leftAtStart: number, resetsAt = RESET): DaySnapshot => ({
  resetsAt,
  day: dayKey(local(at)),
  leftAtStart,
  at: new Date(local(at)).toISOString(),
});
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 0.01, `${actual} ≈ ${expected}`);

test("the host runs these tests in Madrid time", () => {
  assert.equal(new Date("2026-11-04T00:00:00Z").getTimezoneOffset(), -60);
});

test("work weight: weekday 1, weekend day 0.5, partial days pro rata", () => {
  near(workWeight(local("2026-11-04T00:00"), local("2026-11-05T00:00")), 1); // Wed
  near(workWeight(local("2026-11-07T00:00"), local("2026-11-08T00:00")), 0.5); // Sat
  near(workWeight(local("2026-11-04T15:00"), local("2026-11-05T00:00")), 0.5); // Wed from 15:00
  near(workWeight(local("2026-11-03T22:00"), local("2026-11-04T00:00")), 0); // after work hours
  // Wed → reset Tue 22:00: 5 weekdays + 2 weekend halves.
  near(workWeight(local("2026-11-04T00:00"), Date.parse(RESET)), 6);
});

test("work weight across the October DST change stays one weekend day each", () => {
  near(workWeight(local("2026-10-24T00:00"), local("2026-10-26T00:00")), 1);
});

test("real now: Wed 4 Nov, 96% left of a week that started today → 13% left today", () => {
  const b = todayBudget(snap("2026-11-04T00:01", 100), weekly(4), local("2026-11-04T10:18"));
  assert.ok(b);
  near(b.budgetPercent, 100 / 6);
  near(b.leftPercent, 100 / 6 - 4);
  assert.equal(Math.round(b.leftPercent), 13);
});

test("mid-week re-plans from what is left: Fri with 72% left → 18% today", () => {
  const b = todayBudget(snap("2026-11-06T00:01", 72), weekly(37), local("2026-11-06T15:40"));
  assert.ok(b);
  near(b.budgetPercent, 72 / 4);
  near(b.leftPercent, 9);
});

test("a weekend day gets half a weekday", () => {
  const b = todayBudget(snap("2026-11-07T00:01", 45), weekly(55), local("2026-11-07T11:00"));
  assert.ok(b);
  near(b.budgetPercent, (45 * 0.5) / 3);
});

test("over budget shows 0 left, never negative", () => {
  const b = todayBudget(snap("2026-11-09T00:01", 30), weekly(91), local("2026-11-09T17:20"));
  assert.ok(b);
  near(b.budgetPercent, 15);
  assert.equal(b.leftPercent, 0);
});

test("a reset mid-afternoon gives the last day only its hours before the reset", () => {
  const reset = new Date(local("2026-11-10T14:00")).toISOString();
  // Tue 10 Nov is the last day: everything left is today's.
  const b = todayBudget(snap("2026-11-10T00:01", 10, reset), weekly(92, reset), local("2026-11-10T11:00"));
  assert.ok(b);
  near(b.budgetPercent, 10);
  near(b.leftPercent, 8);
});

test("a snapshot taken mid-day counts only the work hours still ahead", () => {
  // Plugin first ran at 15:00 Wed: today is half a weekday, 5.5 days in all.
  const b = todayBudget(snap("2026-11-04T15:00", 96), weekly(4), local("2026-11-04T16:00"));
  assert.ok(b);
  near(b.budgetPercent, (96 * 0.5) / 5.5);
});

test("no budget after the day's work hours, nor without a snapshot for today", () => {
  assert.equal(todayBudget(snap("2026-11-03T22:05", 100), weekly(0), local("2026-11-03T22:10")), null);
  assert.equal(todayBudget(snap("2026-11-04T00:01", 100), weekly(4), local("2026-11-05T09:00")), null);
  assert.equal(todayBudget(null, weekly(4), local("2026-11-04T10:00")), null);
});

test("snapshot: kept for the same day and window, renewed on a new day or window", () => {
  const first = nextSnapshot(null, weekly(2), local("2026-11-04T00:01"));
  assert.ok(first);
  assert.equal(first.leftAtStart, 98);
  assert.equal(first.day, "2026-11-04");

  // Same day; the reset time wobbles by milliseconds.
  assert.equal(nextSnapshot(first, weekly(4, "2026-11-10T21:00:00.000Z"), local("2026-11-04T10:18")), first);

  const nextDay = nextSnapshot(first, weekly(20), local("2026-11-05T00:02"));
  assert.ok(nextDay && nextDay !== first);
  assert.equal(nextDay.leftAtStart, 80);
  assert.equal(nextDay.day, "2026-11-05");

  const newWindow = nextSnapshot(first, weekly(0, "2026-11-17T21:00:00.000Z"), local("2026-11-04T22:30"));
  assert.ok(newWindow && newWindow !== first);
  assert.equal(newWindow.leftAtStart, 100);

  assert.equal(nextSnapshot(first, weekly(4, null), local("2026-11-04T11:00")), null);
});

// --- the daily plan ---------------------------------------------------------

test("presets: Lighter weekends is the default and the old fixed rule", () => {
  assert.deepEqual(DEFAULT_PLAN, PLAN_PRESETS.lighter);
  near(workWeight(local("2026-11-04T00:00"), Date.parse(RESET)), 6);
  near(workWeight(local("2026-11-04T00:00"), Date.parse(RESET), PLAN_PRESETS.lighter), 6);
});

test("presets: each day's share of the week", () => {
  const pct = (plan: readonly number[]) => weekShares(plan).map((s) => Math.round(s * 1000) / 10);
  assert.deepEqual(pct(PLAN_PRESETS.even), [14.3, 14.3, 14.3, 14.3, 14.3, 14.3, 14.3]);
  assert.deepEqual(pct(PLAN_PRESETS.lighter), [16.7, 16.7, 16.7, 16.7, 16.7, 8.3, 8.3]);
  assert.deepEqual(pct(PLAN_PRESETS.weekdays), [20, 20, 20, 20, 20, 0, 0]);
});

test("real now with each preset: Wed 4 Nov, 96% left at 09:00, 93% now", () => {
  const snapshot = snap("2026-11-04T09:00", 96);
  const at = (plan: readonly number[]) => todayBudget(snapshot, weekly(7), local("2026-11-04T10:55"), plan);
  const lighter = at(PLAN_PRESETS.lighter);
  assert.ok(lighter);
  near(lighter.budgetPercent, 16);
  near(lighter.leftPercent, 13);
  const even = at(PLAN_PRESETS.even);
  assert.ok(even);
  near(even.budgetPercent, 96 / 7);
  near(even.leftPercent, 96 / 7 - 3);
  const weekdays = at(PLAN_PRESETS.weekdays);
  assert.ok(weekdays);
  near(weekdays.budgetPercent, 96 / 5);
  near(weekdays.leftPercent, 96 / 5 - 3);
});

test("custom plan: a double Wednesday gets twice a weekday's share", () => {
  const plan = [1, 1, 2, 1, 1, 0.5, 0.5];
  const b = todayBudget(snap("2026-11-04T09:00", 96), weekly(7), local("2026-11-04T10:55"), plan);
  assert.ok(b);
  near(b.budgetPercent, (96 * 2) / 7);
});

test("custom plan: the weekend re-plans from what is left", () => {
  // Sat 7 Nov with 45% left, reset Tue: Sat 1, Sun 0, Mon 1, Tue 1 → a third each.
  const plan = [1, 1, 1, 1, 1, 1, 0];
  const b = todayBudget(snap("2026-11-07T00:01", 45), weekly(55), local("2026-11-07T11:00"), plan);
  assert.ok(b);
  near(b.budgetPercent, 15);
});

test("a day off in the plan gets a budget of 0, not null", () => {
  const b = todayBudget(snap("2026-11-07T00:01", 45), weekly(56), local("2026-11-07T11:00"), PLAN_PRESETS.weekdays);
  assert.deepEqual(b, { budgetPercent: 0, leftPercent: 0 });
  // Still null after the day's work hours, whatever the plan.
  assert.equal(todayBudget(snap("2026-11-03T22:05", 100), weekly(0), local("2026-11-03T22:10"), PLAN_PRESETS.even), null);
});

test("a plan with no day left before the reset gives no budget", () => {
  // Mon 9 Nov, reset Tue 22:00, a plan that only works Wednesdays.
  const plan = [0, 0, 1, 0, 0, 0, 0];
  assert.equal(todayBudget(snap("2026-11-09T09:00", 40), weekly(60), local("2026-11-09T10:00"), plan), null);
});

test("plan: parse, validate and name its preset", () => {
  assert.deepEqual(parsePlan("[1,1,1,1,1,0.5,0.5]"), [1, 1, 1, 1, 1, 0.5, 0.5]);
  assert.equal(parsePlan("[1,1,1]"), null);
  assert.equal(parsePlan("[0,0,0,0,0,0,0]"), null);
  assert.equal(parsePlan("[1,1,1,1,1,1,3]"), null);
  assert.equal(parsePlan("[1,1,1,1,1,1,-1]"), null);
  assert.equal(parsePlan("not json"), null);
  assert.equal(isDayPlan([1, 1, 1, 1, 1, 1, Number.NaN]), false);
  assert.equal(presetOf([1, 1, 1, 1, 1, 1, 1]), "even");
  assert.equal(presetOf([1, 1, 1, 1, 1, 0.5, 0.5]), "lighter");
  assert.equal(presetOf([1, 1, 1, 1, 1, 0, 0]), "weekdays");
  assert.equal(presetOf([1, 1, 2, 1, 1, 0.5, 0.5]), "custom");
});

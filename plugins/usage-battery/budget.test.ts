// Run with: npm test (TZ=Europe/Madrid, so local days match the examples).
import assert from "node:assert/strict";
import { test } from "node:test";
import { dayKey, nextSnapshot, todayBudget, workWeight, type DaySnapshot } from "./budget.ts";

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

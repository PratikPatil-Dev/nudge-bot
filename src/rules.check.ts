// Run: npm run check
import assert from "node:assert/strict";
import {
  checkDraft,
  dueNow,
  inRange,
  isLevel,
  missedInARow,
  nextStep,
  paceNote,
  parseDuration,
  type Range,
  shouldPing,
  shouldTellPartner,
  streak,
  toMin as t,
  windowProgress,
} from "./rules.js";

const goal = { target: 5, windows: [["10:00", "20:00"]] as Range[] };
const quiet: Range = ["23:00", "08:00"];
const now = 1_000_000_000_000;
const ago = (min: number) => now - min * 60_000;

assert.equal(shouldPing(goal, 0, t("09:00"), now, quiet), null, "before window");
assert.equal(shouldPing(goal, 0, t("20:00"), now, quiet), null, "window closed");
assert.equal(shouldPing(goal, 5, t("15:00"), now, quiet), null, "target met");
assert.equal(shouldPing(goal, 3, t("15:00"), now, quiet), null, "on pace (expected 2.5)");

assert.equal(shouldPing(goal, 0, t("10:30"), now, quiet)?.level, "soft", "slightly behind");
assert.equal(shouldPing(goal, 1, t("15:00"), now, quiet)?.level, "firm", "1.5 behind");
assert.deepEqual(shouldPing(goal, 3, t("19:30"), now, quiet), { level: "last", minsLeft: 30 }, "last hour");

assert.equal(shouldPing(goal, 1, t("15:00"), now, quiet, { at: ago(59), level: "firm" }), null, "cooldown (60 min)");
assert.equal(shouldPing(goal, 1, t("15:00"), now, quiet, { at: ago(61), level: "firm" })?.level, "firm", "cooldown over");
assert.equal(shouldPing(goal, 3, t("19:30"), now, quiet, { at: ago(10), level: "firm" })?.level, "last", "escalation skips cooldown");

const late = { target: 2, windows: [["07:00", "23:30"]] as Range[] };
assert.equal(shouldPing(late, 0, t("23:10"), now, quiet), null, "quiet hours beat the window");
assert.ok(inRange(t("01:00"), quiet) && !inRange(t("12:00"), quiet), "quiet hours wrap midnight");

// Two windows with a break, minute-based target: 45 + 45 = 90 min of window time
const prep = { target: 90, windows: [["18:00", "18:45"], ["19:30", "20:15"]] as Range[] };
assert.deepEqual(windowProgress(prep.windows, t("19:00")), { total: 90, elapsed: 45, inside: false, minsLeft: 45 });
assert.equal(shouldPing(prep, 0, t("19:00"), now, quiet), null, "no pings during the break");
assert.equal(shouldPing(prep, 0, t("18:05"), now, quiet)?.level, "soft", "5 min behind isn't firm (10% rule)");
assert.equal(shouldPing(prep, 0, t("18:15"), now, quiet)?.level, "firm", "15 min behind is firm");
assert.equal(shouldPing(prep, 50, t("19:35"), now, quiet), null, "on pace after the break (expected 50)");
assert.equal(shouldPing(prep, 40, t("19:35"), now, quiet)?.level, "firm", "second window counts the first one's minutes");
assert.deepEqual(shouldPing(prep, 45, t("19:50"), now, quiet), { level: "last", minsLeft: 25 }, "last third of a short goal");
assert.equal(shouldTellPartner({ ...prep, tellPartnerAfterMisses: 1 }, 45, t("19:00"), 1, false), false, "break isn't the end");
assert.equal(shouldTellPartner({ ...prep, tellPartnerAfterMisses: 1 }, 45, t("20:15"), 1, false), true, "last window closed");

assert.equal(parseDuration("30m"), 30 * 60_000);
assert.equal(parseDuration("2h"), 2 * 3_600_000);
for (const bad of ["0m", "25h", "2", "h", "1.5h", "-1h", "off"]) assert.equal(parseDuration(bad), null, bad);

const met = new Set(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-03"]);
assert.equal(streak(met, "2026-03-03"), 1, "met today, gap before");
assert.equal(streak(met, "2026-03-02"), 3, "today not met yet, streak alive across month end");
assert.equal(streak(met, "2026-03-04"), 1, "yesterday counts");
assert.equal(streak(met, "2026-03-05"), 0, "broken");
assert.equal(streak(new Set(), "2026-03-05"), 0);

assert.equal(missedInARow(met, "2026-03-03", "2026-01-01"), 0, "met today");
assert.equal(missedInARow(met, "2026-03-02", "2026-01-01"), 1, "missed today only");
assert.equal(missedInARow(met, "2026-03-06", "2026-01-01"), 3, "missed 3 days");
assert.equal(missedInARow(new Set(), "2026-03-06", "2026-03-05"), 2, "don't count days before first use");

const told = { ...goal, tellPartnerAfterMisses: 2 };
assert.equal(shouldTellPartner(told, 3, t("20:05"), 2, false), true, "window closed, 2 misses in a row");
assert.equal(shouldTellPartner(told, 3, t("19:55"), 2, false), false, "window still open");
assert.equal(shouldTellPartner(told, 5, t("20:05"), 2, false), false, "target met");
assert.equal(shouldTellPartner(told, 3, t("20:05"), 1, false), false, "not enough misses yet");
assert.equal(shouldTellPartner(told, 3, t("20:05"), 2, true), false, "only once per day");
assert.equal(shouldTellPartner(goal, 0, t("20:05"), 9, false), false, "goal has no partner rule");

const facts = "done today: 1/5\nremaining: 4 (~20 min)\nstreak: 6 days";
assert.equal(checkDraft("Still 1/5? 20 min and you're done. Don't kill a 6-day streak.", ["1/5"], facts), null, "good draft");
assert.match(checkDraft("Just 4 more, go!", ["1/5"], facts) ?? "", /missing 1\/5/, "dropped the count");
assert.match(checkDraft("1/5, only a 10 min job", ["1/5"], facts) ?? "", /invented numbers 10/, "made up a number");
assert.equal(checkDraft("1/5 or I'm telling SAM", ["Sam", "1/5"], facts), null, "must is case-insensitive");
assert.ok(isLevel("last") && !isLevel("toString") && !isLevel("x"), "isLevel");
assert.equal(checkDraft("Alex applied to only 0 of 30 jobs", ["Alex"], "0 of 30", [0, 30]), null, "numbers in words");
assert.match(checkDraft("Alex skipped all 30 jobs", ["Alex"], "0 of 30", [0, 30]) ?? "", /missing numbers 0/, "30 doesn't count as 0");
assert.match(checkDraft("1/5 " + "a".repeat(600), ["1/5"], facts) ?? "", /too long/);

assert.ok(dueNow(t("08:00"), "08:00") && dueNow(t("09:59"), "08:00"), "due within grace");
assert.ok(!dueNow(t("07:59"), "08:00") && !dueNow(t("10:00"), "08:00") && !dueNow(t("15:00"), "08:00"), "not due outside grace");

// Just logged progress -> no nudge for 45 min, whatever the level
assert.equal(shouldPing(goal, 1, t("15:00"), now, quiet, undefined, ago(20)), null, "active 20 min ago");
assert.equal(shouldPing(goal, 3, t("19:30"), now, quiet, undefined, ago(20)), null, "even a last call waits");
assert.equal(shouldPing(goal, 1, t("15:00"), now, quiet, undefined, ago(50))?.level, "firm", "quiet period over");

assert.deepEqual(nextStep(30, 13, 3), { units: 3, mins: 9 }, "3 applications, not all 17");
assert.deepEqual(nextStep(30, 29, 3), { units: 1, mins: 3 }, "never more than what's left");
assert.deepEqual(nextStep(90, 0, 1), { units: 10, mins: 10 }, "minute goals: a 10-minute block");
assert.deepEqual(nextStep(5, 0, 30), { units: 1, mins: 30 }, "at least one unit");

const day = { target: 30, windows: [["06:00", "20:00"]] as Range[] }; // 840 min
assert.equal(paceNote(day, 13, t("14:00")), "4 behind pace", "expected 17 at 14:00");
assert.equal(paceNote(day, 17, t("14:00")), "on pace 👍");
assert.equal(paceNote(day, 30, t("14:00")), "done for today ✅");
assert.equal(paceNote(day, 0, t("05:00")), "window opens at 06:00");

console.log("rules: all checks passed");

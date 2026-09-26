// Pure decision logic: no Telegram, no DB, no clock. Every "should I ping?" answer comes from here.

export type Level = "soft" | "firm" | "last";
export type LastPing = { at: number; level: Level };

const RANK: Record<Level, number> = { soft: 0, firm: 1, last: 2 };
const COOLDOWN_MS = 60 * 60_000;
// Quiet period after a /done. Under an hour so a last call can still land before the window closes.
const ACTIVE_MS = 45 * 60_000;
const STEP_MINS = 10; // size of the "next small step" a nudge asks for

export const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// [start, end) in minutes of day; start > end means the range wraps midnight (e.g. quiet hours 23:00–08:00)
export const inRange = (now: number, [start, end]: [string, string]) => {
  const s = toMin(start);
  const e = toMin(end);
  return s <= e ? now >= s && now < e : now >= s || now < e;
};

export type Range = [string, string];

// A goal can have several windows (e.g. 18:30-19:15 and 20:00-20:45). Pace only counts window minutes,
// so a dinner break in between neither pings you nor makes you "fall behind".
export function windowProgress(windows: Range[], nowMin: number) {
  let total = 0;
  let elapsed = 0;
  let inside = false;
  for (const [s, e] of windows) {
    const a = toMin(s);
    const b = toMin(e);
    total += b - a;
    if (nowMin >= b) elapsed += b - a;
    else if (nowMin >= a) {
      elapsed += nowMin - a;
      inside = true;
    }
  }
  return { total, elapsed, inside, minsLeft: total - elapsed };
}

export const windowsEnd = (windows: Range[]) => Math.max(...windows.map(([, e]) => toMin(e)));

export function shouldPing(
  goal: { target: number; windows: Range[] },
  done: number,
  nowMin: number,
  nowMs: number,
  quietHours: Range,
  last?: LastPing,
  lastDoneMs?: number,
): { level: Level; minsLeft: number } | null {
  if (done >= goal.target || inRange(nowMin, quietHours)) return null;
  // You just logged progress: you're working, so don't nag, even if still behind pace
  if (lastDoneMs !== undefined && nowMs - lastDoneMs < ACTIVE_MS) return null;
  const { total, elapsed, inside, minsLeft } = windowProgress(goal.windows, nowMin);
  if (!inside) return null;

  const expected = goal.target * (elapsed / total);
  if (done >= expected) return null; // on pace

  // Last call = final hour, or final third for short windows (a 90-min goal would otherwise be "last" from minute 30).
  // Firm = behind by at least 10% of the target (or 1 unit), so minute-based goals aren't "firm" at 1 minute behind.
  const level: Level =
    minsLeft <= Math.min(60, total / 3) ? "last" : expected - done >= Math.max(1, goal.target * 0.1) ? "firm" : "soft";

  // Cooldown between pings, but escalating (soft -> firm -> last) always gets through,
  // otherwise a firm ping at 80 min left would swallow the last call.
  if (last && RANK[level] <= RANK[last.level] && nowMs - last.at < COOLDOWN_MS) return null;

  return { level, minsLeft };
}

// The small, doable ask a nudge leads with (~10 minutes of work), instead of the whole remaining pile
export function nextStep(target: number, done: number, minsPerUnit: number) {
  const units = Math.min(Math.max(target - done, 0), Math.max(1, Math.floor(STEP_MINS / minsPerUnit)));
  return { units, mins: Math.round(units * minsPerUnit) };
}

// One line for the /done reply: where you stand against the pace right now
export function paceNote(goal: { target: number; windows: Range[] }, done: number, nowMin: number) {
  if (done >= goal.target) return "done for today ✅";
  const { total, elapsed } = windowProgress(goal.windows, nowMin);
  if (elapsed === 0) return `window opens at ${goal.windows[0]![0]}`;
  const behind = Math.floor(goal.target * (elapsed / total)) - done;
  return behind > 0 ? `${behind} behind pace` : "on pace 👍";
}

// "30m" / "2h" -> ms, capped at 24h. Anything else -> null.
export function parseDuration(s: string): number | null {
  const m = /^(\d+)(m|h)$/.exec(s);
  if (!m) return null;
  const ms = Number(m[1]) * (m[2] === "h" ? 3_600_000 : 60_000);
  return ms > 0 && ms <= 24 * 3_600_000 ? ms : null;
}

export const prevDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

// Consecutive days the target was met, ending today, or ending yesterday if today isn't met yet (streak still alive).
export function streak(metDays: Set<string>, today: string) {
  let day = metDays.has(today) ? today : prevDay(today);
  let n = 0;
  while (metDays.has(day)) {
    n++;
    day = prevDay(day);
  }
  return n;
}

// Consecutive unmet days ending today, counting no further back than firstDay (when you started using the bot).
export function missedInARow(metDays: Set<string>, today: string, firstDay: string) {
  let day = today;
  let n = 0;
  while (day >= firstDay && !metDays.has(day)) {
    n++;
    day = prevDay(day);
  }
  return n;
}

// Tell the partner once the goal's last window has closed unmet and you've missed enough days in a row.
// Snooze deliberately plays no part here: snoozing must not be a way to dodge the partner.
export function shouldTellPartner(
  goal: { target: number; windows: Range[]; tellPartnerAfterMisses?: number | undefined },
  done: number,
  nowMin: number,
  misses: number,
  alreadySent: boolean,
) {
  const after = goal.tellPartnerAfterMisses;
  return !!after && !alreadySent && done < goal.target && nowMin >= windowsEnd(goal.windows) && misses >= after;
}

// Why an LLM draft can't be sent, or null if it's fine. It must contain every `must` string and every
// `mustNumbers` number (as a whole number, in any wording: "0 of 30" and "0/30" both count),
// and may only use numbers that appear in `source` (the facts + profile), so it can't invent stats.
export function checkDraft(text: string, must: string[], source: string, mustNumbers: number[] = []): string | null {
  const lower = text.toLowerCase();
  const missing = must.filter((m) => !lower.includes(m.toLowerCase()));
  if (missing.length) return `missing ${missing.join(", ")}`;
  const used: string[] = text.match(/\d+/g) ?? [];
  const lostNumbers = mustNumbers.filter((n) => !used.includes(String(n)));
  if (lostNumbers.length) return `missing numbers ${lostNumbers.join(", ")}`;
  const allowed = new Set(source.match(/\d+/g) ?? []);
  const invented = used.filter((n) => !allowed.has(n));
  if (invented.length) return `invented numbers ${invented.join(", ")}`;
  if (text.length > 600) return `too long (${text.length} chars)`;
  return null;
}

export const isLevel = (s: string): s is Level => Object.hasOwn(RANK, s);

// Once-a-day messages (morning plan, night recap) go out in the first `graceMin` after their time.
// The grace window stops a bot started at 3pm from sending "good morning".
export const dueNow = (nowMin: number, at: string, graceMin = 120) => nowMin >= toMin(at) && nowMin < toMin(at) + graceMin;

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { z } from "zod";
import { morningPlan, nightRecap, nudge, PROFILE_PATH, partnerNudge, remember, toldNudge } from "./nudge.js";
import {
  dueNow,
  isLevel,
  type Level,
  type LastPing,
  missedInARow,
  parseDuration,
  prevDay,
  shouldPing,
  shouldTellPartner,
  streak,
  toMin,
  windowProgress,
} from "./rules.js";

const token = process.env.BOT_TOKEN;
const chatId = Number(process.env.CHAT_ID);
if (!token || !chatId) throw new Error("BOT_TOKEN and CHAT_ID must be set in .env");
// Optional. The partner must /start the bot once (Telegram won't let bots message people first); /start shows their ID.
const partnerId = process.env.PARTNER_CHAT_ID ? Number(process.env.PARTNER_CHAT_ID) : undefined;
if (Number.isNaN(partnerId)) throw new Error("PARTNER_CHAT_ID must be a number");

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM (24h)");
const Config = z.object({
  timezone: z.string(),
  quietHours: z.tuple([hhmm, hhmm]),
  me: z.string().default("Your friend"), // how the partner hears about you
  partner: z.string().default("your partner"), // how you hear about them
  morning: hhmm.optional(), // morning plan time, defaults to when quiet hours end
  recap: hhmm.optional(), // night recap time, defaults to when quiet hours start

  goals: z.array(
    z
      .object({
        id: z.string(),
        label: z.string().optional(), // plain words for your partner, e.g. "job applications"
        target: z.number().int().positive(),
        windows: z.array(z.tuple([hhmm, hhmm])).min(1), // e.g. [["18:30","19:15"],["20:00","20:45"]]
        why: z.string(),
        minsPerUnit: z.number().positive(),
        tellPartnerAfterMisses: z.number().int().positive().optional(),
      })
      .refine(
        (g) => g.windows.every(([s, e], i) => toMin(s) < toMin(e) && (i === 0 || toMin(s) >= toMin(g.windows[i - 1]![1]))),
        "each window must start before it ends, and windows must be in order without overlapping",
      ),
  ),
});
if (!existsSync("goals.json")) throw new Error("no goals.json: copy goals.example.json to goals.json and make it yours");
const config = Config.parse(JSON.parse(readFileSync("goals.json", "utf8")));
const morningAt = config.morning ?? config.quietHours[1];
const recapAt = config.recap ?? config.quietHours[0];

mkdirSync("data", { recursive: true });
const db = new DatabaseSync("data/nudge.db");
db.exec(`CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY,
  goal_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  day TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Persisted (unlike pings/snoozes) so a restart after the window closes can't tell your partner twice
db.exec(`CREATE TABLE IF NOT EXISTS partner_alerts (
  goal_id TEXT NOT NULL,
  day TEXT NOT NULL,
  reason TEXT,
  sent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (goal_id, day)
)`);
// Everything the bot has sent, so the LLM can see its own recent messages and not repeat itself
db.exec(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  goal_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'nudge' | 'partner' | 'told' | 'morning' | 'recap' (goal_id '*' for the daily ones)
  text TEXT NOT NULL,
  day TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// "YYYY-MM-DD" in the configured timezone, so "today" flips at your midnight, not UTC's
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: config.timezone });
const nowMin = () =>
  toMin(new Date().toLocaleTimeString("en-GB", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));

const doneOn = (goalId: string, day: string) =>
  Number(db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM logs WHERE goal_id = ? AND day = ?").get(goalId, day)?.n);
const doneToday = (goalId: string) => doneOn(goalId, today());

const metDays = (goalId: string, target: number) =>
  new Set(
    db
      .prepare("SELECT day FROM logs WHERE goal_id = ? GROUP BY day HAVING SUM(count) >= ?")
      .all(goalId, target)
      .map((r) => String(r.day)),
  );
const streakFor = (goalId: string, target: number) => streak(metDays(goalId, target), today());
const missesFor = (goalId: string, target: number) => {
  const first = db.prepare("SELECT MIN(day) AS d FROM logs").get()?.d;
  return missedInARow(metDays(goalId, target), today(), typeof first === "string" ? first : today());
};
const partnerRow = (goalId: string) =>
  db.prepare("SELECT reason, sent FROM partner_alerts WHERE goal_id = ? AND day = ?").get(goalId, today()) as
    | { reason: string | null; sent: number }
    | undefined;

const recentFor = (goalId: string, kind: string) =>
  db
    .prepare("SELECT text FROM messages WHERE goal_id = ? AND kind = ? ORDER BY id DESC LIMIT 3")
    .all(goalId, kind)
    .map((r) => String(r.text))
    .reverse();
const sentToday = (kind: string) =>
  db.prepare("SELECT 1 FROM messages WHERE goal_id = '*' AND kind = ? AND day = ?").get(kind, today()) !== undefined;
const nudgesToday = (goalId: string) =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE goal_id = ? AND kind = 'nudge' AND day = ?").get(goalId, today())?.n);

// Send and remember it. Logged only after Telegram accepted it.
async function send(to: number, goalId: string, kind: string, text: string) {
  await bot.telegram.sendMessage(to, text);
  db.prepare("INSERT INTO messages (goal_id, kind, text, day) VALUES (?, ?, ?, ?)").run(goalId, kind, text, today());
}

const fire = (n: number) => (n > 0 ? ` · 🔥 ${n}d` : "");
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-GB", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit" });

// ponytail: in-memory, so a restart forgets pings and snoozes; move to a DB table if that gets annoying
const lastPing = new Map<string, LastPing>();
const snoozed = new Map<string, number>(); // goal id, or "*" for all -> snoozed until (ms)
const snoozedUntil = (goalId: string) => Math.max(snoozed.get(goalId) ?? 0, snoozed.get("*") ?? 0);

type Goal = (typeof config.goals)[number];
const llmLabel = process.env.LLM_ENABLED === "true" ? `llm ${process.env.LLM_MODEL}` : "templates only";
// One list feeds both Telegram's "/" menu (setMyCommands at startup) and the unknown-command help text
const COMMANDS = [
  { command: "done", args: "<goal> [count]", description: "Log progress, e.g. /done jobs 2" },
  { command: "status", args: "", description: "Today's progress, streaks, snoozes" },
  { command: "snooze", args: "[goal] <30m|2h|off>", description: "Pause nudges for a while" },
  { command: "excuse", args: "<goal|all> <reason>", description: "Explain a miss before your partner hears" },
  { command: "remember", args: "<note>", description: "Teach the bot something about you" },
  { command: "preview", args: "<goal|partner|morning|recap> ...", description: "See a nudge, partner report, plan or recap now" },
];
const HELP = COMMANDS.map((c) => `/${c.command} ${c.args}`.trim()).join("\n");

const bot = new Telegraf(token);

// /start is open so a partner can get their chat ID. You get everything; the partner gets read-only /status.
bot.start((ctx) => ctx.reply(`Your chat ID: ${ctx.chat.id}`));
bot.use((ctx, next) => {
  if (ctx.chat?.id === chatId) return next();
  if (partnerId && ctx.chat?.id === partnerId && ctx.text?.startsWith("/status")) return next();
});

bot.command("done", (ctx) => {
  const [goalId, countArg = "1"] = ctx.args;
  const goal = config.goals.find((g) => g.id === goalId);
  if (!goal) return ctx.reply(`Usage: /done <goal> [count]\nGoals: ${config.goals.map((g) => g.id).join(", ")}`);

  const count = Number(countArg);
  if (!Number.isInteger(count) || count < 1 || count > 100) return ctx.reply("Count must be a whole number from 1 to 100.");

  db.prepare("INSERT INTO logs (goal_id, count, day) VALUES (?, ?, ?)").run(goal.id, count, today());
  const done = doneToday(goal.id);
  return ctx.reply(`${goal.id}: ${done}/${goal.target} today${done >= goal.target ? ` ✅${fire(streakFor(goal.id, goal.target))}` : ""}`);
});

bot.command("status", (ctx) => {
  const lines = config.goals.map((g) => {
    const done = doneToday(g.id);
    const until = snoozedUntil(g.id);
    const zz = until > Date.now() ? ` · 😴 till ${clock(until)}` : "";
    return `${done >= g.target ? "✅" : "⏳"} ${g.id}: ${done}/${g.target}${fire(streakFor(g.id, g.target))}${zz}`;
  });
  return ctx.reply(`Today (${today()})\n${lines.join("\n")}`);
});

// /snooze 2h | /snooze jobs 30m | /snooze off | /snooze jobs off
bot.command("snooze", (ctx) => {
  const [a, b] = ctx.args;
  const goalId = b === undefined ? "*" : a;
  const arg = b ?? a ?? "";
  const usage = `Usage: /snooze [goal] <30m|2h|off>\nGoals: ${config.goals.map((g) => g.id).join(", ")}`;
  if (!goalId || (goalId !== "*" && !config.goals.some((g) => g.id === goalId))) return ctx.reply(usage);

  const what = goalId === "*" ? "all goals" : goalId;
  if (arg === "off") {
    if (goalId === "*") snoozed.clear();
    else snoozed.delete(goalId);
    return ctx.reply(`Snooze off for ${what}.`);
  }

  const ms = parseDuration(arg);
  if (!ms) return ctx.reply(usage);
  const until = Date.now() + ms;
  snoozed.set(goalId, until);
  return ctx.reply(`😴 ${what} snoozed till ${clock(until)}.`);
});

// /excuse jobs sick today | /excuse all travelling. Doesn't hide the miss: the partner still hears, with your reason.
bot.command("excuse", (ctx) => {
  const [goalId, ...words] = ctx.args;
  const reason = words.join(" ").trim().slice(0, 200);
  const goals = goalId === "all" ? config.goals : config.goals.filter((g) => g.id === goalId);
  if (!goals.length || !reason)
    return ctx.reply(`Usage: /excuse <goal|all> <reason>\nGoals: ${config.goals.map((g) => g.id).join(", ")}`);

  const late = goals.filter((g) => partnerRow(g.id)?.sent).map((g) => g.id);
  for (const g of goals.filter((g) => !late.includes(g.id)))
    db.prepare(
      "INSERT INTO partner_alerts (goal_id, day, reason) VALUES (?, ?, ?) ON CONFLICT (goal_id, day) DO UPDATE SET reason = excluded.reason",
    ).run(g.id, today(), reason);
  const lateMsg = late.length ? `\nToo late for ${late.join(", ")}: ${config.partner} already knows.` : "";
  return ctx.reply(`Noted. If you miss today, ${config.partner} gets your reason instead of the usual report.${lateMsg}`);
});

// /remember I work better right after the gym -> appended to data/profile.md, used from the next message on
bot.command("remember", (ctx) => {
  const note = ctx.payload.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!note) return ctx.reply("Usage: /remember <something about you the bot should know>");
  remember(note, today());
  return ctx.reply(`Got it, saved to your profile: "${note}"`);
});

// Everything the nudge writer gets. Shared by the heartbeat and /preview, so a preview is exactly what a real ping would be.
function nudgeStats(g: Goal, done: number, minsLeft: number) {
  // Same rule the window-close check uses, so the warning only appears when it would really happen
  const warn = partnerId && g.tellPartnerAfterMisses && !partnerRow(g.id)?.reason && missesFor(g.id, g.target) >= g.tellPartnerAfterMisses;
  return {
    ...g,
    done,
    minsLeft,
    streak: streakFor(g.id, g.target),
    pingsToday: nudgesToday(g.id),
    warnPartner: warn ? config.partner : undefined,
  };
}

const writeMorning = () => {
  const yesterday = prevDay(today());
  const lines = config.goals.map((g) => ({ ...g, done: 0, streak: streakFor(g.id, g.target), yesterday: doneOn(g.id, yesterday) }));
  return morningPlan(lines, recentFor("*", "morning"));
};

const writeRecap = () => {
  const lines = config.goals.map((g) => {
    const done = doneToday(g.id);
    // A missed goal's streak is over, so show 0 rather than yesterday's number
    return { ...g, done, streak: done >= g.target ? streakFor(g.id, g.target) : 0, partnerTold: !!partnerRow(g.id)?.sent };
  });
  return nightRecap(lines, recentFor("*", "recap"), config.partner);
};

// Once a day each; the messages table is the "already sent" record, so restarts can't double-send
async function dailyMessages(min: number) {
  if (dueNow(min, morningAt) && !sentToday("morning")) await send(chatId, "*", "morning", await writeMorning());
  if (dueNow(min, recapAt) && !sentToday("recap")) await send(chatId, "*", "recap", await writeRecap());
}

// What the partner report is built from. Today is unmet when this runs, so streakFor is the streak that just ended.
const missFor = (g: Goal, done: number, misses: number) => ({
  me: config.me,
  partner: config.partner,
  id: g.id,
  label: g.label ?? g.id,
  why: g.why,
  done,
  target: g.target,
  misses,
  brokenStreak: streakFor(g.id, g.target),
  reason: partnerRow(g.id)?.reason ?? null,
});

const PREVIEW_USAGE = () =>
  `Usage:\n/preview <goal> [soft|firm|last]\n/preview partner <goal>\n/preview morning | recap\nGoals: ${config.goals.map((x) => x.id).join(", ")}`;

// Everything here is written right now and sent only to you: not saved, no timers touched, nothing sent to the partner.
bot.command("preview", async (ctx) => {
  const [what = "", arg] = ctx.args;
  const header = (label: string) => `🔍 Preview · ${llmLabel} · ${label}`;

  if (what === "morning" || what === "recap") {
    await ctx.sendChatAction("typing");
    return ctx.reply(`${header(what)}\n\n${await (what === "morning" ? writeMorning() : writeRecap())}`);
  }

  if (what === "partner") {
    const g = config.goals.find((x) => x.id === arg);
    if (!g) return ctx.reply(PREVIEW_USAGE());
    await ctx.sendChatAction("typing");
    // Pretend today is a miss even if it isn't yet, so there's something to report
    const done = Math.min(doneToday(g.id), g.target - 1);
    const miss = missFor(g, done, Math.max(1, missesFor(g.id, g.target)));
    const toPartner = await partnerNudge(miss, recentFor(g.id, "partner"));
    const toYou = await toldNudge(miss, toPartner);
    return ctx.reply(`${header(`partner · ${g.id}`)}\n\nShe'd get:\n${toPartner}\n\nYou'd get:\n${toYou}`);
  }

  const g = config.goals.find((x) => x.id === what);
  const level = arg ?? "firm";
  if (!g || !isLevel(level)) return ctx.reply(PREVIEW_USAGE());
  await ctx.sendChatAction("typing");
  const { minsLeft } = windowProgress(g.windows, nowMin());
  const text = await nudge(level, nudgeStats(g, doneToday(g.id), minsLeft), recentFor(g.id, "nudge"));
  return ctx.reply(`${header(level)}\n\n${text}`);
});

async function tellPartnerIfMissed(g: Goal, done: number, min: number) {
  if (!partnerId) return;
  const misses = missesFor(g.id, g.target);
  if (!shouldTellPartner(g, done, min, misses, !!partnerRow(g.id)?.sent)) return;

  const miss = missFor(g, done, misses);
  const msg = await partnerNudge(miss, recentFor(g.id, "partner"));
  await send(partnerId, g.id, "partner", msg);
  console.log(`📣 sent to ${config.partner} (${g.id}, ${done}/${g.target}):\n${msg}`);
  db.prepare(
    "INSERT INTO partner_alerts (goal_id, day, sent) VALUES (?, ?, 1) ON CONFLICT (goal_id, day) DO UPDATE SET sent = 1",
  ).run(g.id, today());
  await send(chatId, g.id, "told", await toldNudge(miss, msg));
}

async function heartbeat() {
  const min = nowMin();
  const ms = Date.now();
  for (const g of config.goals) {
    try {
      const done = doneToday(g.id);
      await tellPartnerIfMissed(g, done, min); // before the snooze check on purpose

      if (snoozedUntil(g.id) > ms) continue;
      const ping = shouldPing(g, done, min, ms, config.quietHours, lastPing.get(g.id));
      if (!ping) continue;

      await send(chatId, g.id, "nudge", await nudge(ping.level, nudgeStats(g, done, ping.minsLeft), recentFor(g.id, "nudge")));
      lastPing.set(g.id, { at: ms, level: ping.level });
    } catch (err) {
      console.error(`heartbeat: failed on ${g.id}`, err);
    }
  }
  // After the goal loop, so a recap sent right as a window closes already includes the partner report
  await dailyMessages(min).catch((err) => console.error("heartbeat: daily message failed", err));
}

const heartbeatMin = Number(process.env.HEARTBEAT_MIN ?? 15);
setInterval(heartbeat, heartbeatMin * 60_000);

// Registered last so it only catches commands nothing above handled (Telegraf ignores those silently otherwise)
bot.on(message("text"), (ctx) => {
  if (ctx.text.startsWith("/")) return ctx.reply(`Don't know that one. Commands:\n${HELP}`);
});

// Per-chat menus: you see everything, your partner only /status, strangers nothing (they're ignored anyway).
// Chat-scoped lists need that person to have /start-ed the bot, which both of you have.
async function registerMenus() {
  const toMenu = (cs: typeof COMMANDS) => cs.map(({ command, description }) => ({ command, description }));
  await bot.telegram.setMyCommands([]);
  await bot.telegram.setMyCommands(toMenu(COMMANDS), { scope: { type: "chat", chat_id: chatId } });
  if (partnerId)
    await bot.telegram.setMyCommands(toMenu(COMMANDS.filter((c) => c.command === "status")), {
      scope: { type: "chat", chat_id: partnerId },
    });
}
registerMenus().catch((err) => console.error("couldn't register the / menu:", err instanceof Error ? err.message : err));

if (!existsSync(PROFILE_PATH)) console.warn(`no ${PROFILE_PATH} yet: copy profile.example.md there so the AI knows you`);
bot.launch();
console.log(`nudge-bot running (long polling, heartbeat every ${heartbeatMin} min, ${llmLabel})`);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

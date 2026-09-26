import { appendFileSync, existsSync, readFileSync } from "node:fs";
import OpenAI from "openai";
import { checkDraft, type Level, nextStep, type Range } from "./rules.js";

type Stats = {
  id: string;
  why: string;
  windows: Range[];
  done: number;
  target: number;
  minsPerUnit: number;
  minsLeft: number;
  streak: number;
  pingsToday: number; // nudges already sent for this goal today
  warnPartner?: string | undefined; // partner's name, set when missing today would get them told
};

type Miss = {
  me: string;
  partner: string;
  id: string;
  label: string; // plain words for the partner, e.g. "job applications"
  why: string;
  done: number;
  target: number;
  misses: number;
  brokenStreak: number;
  reason?: string | null;
};

// ---------- Templates: always work, used when the LLM is off or its draft fails the checks ----------

const fmtWin = (w: Range[]) => w.map(([a, b]) => `${a}-${b}`).join(" + ");
const fmtLeft = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);

const LINES: Record<Level, ((s: Stats, remaining: number, mins: number, left: string) => string)[]> = {
  soft: [
    (s) => `${s.done}/${s.target} ${s.id} today. One now takes ~${s.minsPerUnit} min and keeps you on pace.`,
    (s, _r, _m, left) => `Quick check: ${s.id} at ${s.done}/${s.target}, ${left} left in today's window. Knock one out?`,
    (s, r, m) => `Haven't seen any ${s.id} in a while. ${r} to go, ~${m} min total. Start with one.`,
  ],
  firm: [
    (s, r, m, left) => `You're behind on ${s.id}: ${s.done}/${s.target}, ${left} left. ${r} more ≈ ${m} min. Block the time now.`,
    (s, _r, m) => `${s.id}: ${s.done}/${s.target}. Remember why: ${s.why}. It's about ${m} min in total; start with one.`,
    (s, r, m) => `Falling behind pace on ${s.id}. ${r} left to hit ${s.target}. It's ~${m} min, not a big ask.`,
  ],
  last: [
    (s, r, m, left) => `Last call for ${s.id}: ${s.done}/${s.target}, ${left} of window left. ${r} more, ~${m} min. Now or never.`,
    (s, r, _m, left) => `${left} left and ${s.id} is at ${s.done}/${s.target}. Do ${r} now and today still counts.`,
    (s, r, m) => `Final stretch on ${s.id}. ${r} to go (~${m} min). "${s.why}" doesn't happen by itself.`,
  ],
};

export function template(level: Level, s: Stats) {
  const lines = LINES[level];
  const line = lines[Math.floor(Math.random() * lines.length)]!;
  const remaining = s.target - s.done;
  let msg = line(s, remaining, remaining * s.minsPerUnit, fmtLeft(s.minsLeft));
  if (level === "last" && s.streak > 0) msg += ` Don't break your ${s.streak}-day streak.`;
  if (level === "last" && s.warnPartner) msg += ` If it's still short when the window closes, ${s.warnPartner} gets a note (/excuse if there's a real reason).`;
  return msg;
}

export function partnerTemplate(p: Miss) {
  const head = `${p.me} missed their ${p.label} goal today: only ${p.done} of ${p.target} done.`;
  if (p.reason) return `${head} Their excuse: "${p.reason}". Your call if that's legit 🤨`;
  const inARow = p.misses > 1 ? ` That's ${p.misses} days in a row.` : "";
  const broke = p.brokenStreak > 0 ? ` Broke a ${p.brokenStreak}-day streak.` : "";
  return `${head}${inARow}${broke} Maybe check in on them 👀`;
}

const toldTemplate = (partner: string, id: string) => `📣 Told ${partner} you missed ${id} today.`;

// ---------- Profile: who you are, what works on you, your partner, the bot's persona ----------

export const PROFILE_PATH = "data/profile.md";

// Read fresh on every call, so edits and /remember apply without a restart
const readProfile = () => (existsSync(PROFILE_PATH) ? readFileSync(PROFILE_PATH, "utf8").trim() : "");

export function remember(note: string, day: string) {
  const heading = readProfile().includes("## Remembered") ? "" : "\n\n## Remembered";
  appendFileSync(PROFILE_PATH, `${heading}\n- (${day}) ${note}`);
}

// ---------- LLM: one OpenAI-compatible client covers OpenAI, Gemini (via LLM_BASE_URL), Groq, OpenRouter, Ollama ----------

const llmEnabled = process.env.LLM_ENABLED === "true";
const model = process.env.LLM_MODEL;
// Optional. Thinking models (e.g. gemini-3.8-flash) spend the reply budget thinking and get cut off; "none" turns that off.
// Leave unset for models that don't think or don't accept the parameter.
const reasoningEffort = process.env.LLM_REASONING_EFFORT || undefined;
if (llmEnabled && (!process.env.LLM_API_KEY || !model)) throw new Error("LLM_ENABLED=true needs LLM_API_KEY and LLM_MODEL");
const llm = llmEnabled
  ? new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL || undefined, timeout: 15_000, maxRetries: 1 })
  : null;

const SYSTEM = `You write short Telegram messages for a personal accountability bot.
Default persona (the profile can adjust it): a direct, supportive friend. Honest about the gap, warm about the person, clearly on the user's side. Never preachy, never corporate, no motivational-poster lines.
Respect is not optional, whatever the profile says: never insult, mock, belittle or show contempt (no "drama", "crying", "shut up and work", no jabs at their life choices), and never threaten. Pressure comes from facts and their own goals, not from put-downs.
Be useful: every nudge gives ONE concrete, small next step they can start right now (the "next small step" fact), and makes starting feel easy.
Default language: plain, casual English, unless the profile says otherwise.
Use the profile to make it land: their real reasons, what works and doesn't work on them, their patterns. Use it, don't recite it.
Every request names its reader. Match language and tone to that reader:
- Reader "user": the persona's language for the user. The profile says how much of any other language is okay for the user. The partner's language rules do NOT apply, even when the facts quote a message sent to the partner.
- Reader "partner": the profile's language and tone rules for the partner. Those rules apply ONLY here.
Hard rules:
- 1-3 short sentences. No hashtags, no quotes around the whole message, no preamble. Output only the message.
- Only use numbers that appear in the facts or the profile. Never invent stats.
- Include every "must include" string exactly as written.
- Your recent messages are shown only so you don't repeat their wording. Don't copy their tone or phrases.`;

type Job = {
  reader: "user" | "partner";
  task: string;
  facts: string[];
  must: string[];
  mustNumbers?: number[]; // must appear as whole numbers, in any wording
  recent: string[];
  fallback: string;
};

// Code decides what happens and what the facts are; the LLM only decides how to say it.
// Any failure or a draft that breaks the rules -> the template goes out instead.
async function write(job: Job): Promise<string> {
  if (!llm || !model) return job.fallback;
  const profile = readProfile();
  const facts = job.facts.join("\n");
  const prompt = [
    `Reader: ${job.reader}`,
    `Task: ${job.task}`,
    `Facts:\n${facts}`,
    `Must include: ${job.must.map((m) => `"${m}"`).join(", ")}`,
    job.recent.length && `Your recent messages about this (don't reuse their wording or tone):\n${job.recent.map((r) => `- ${r}`).join("\n")}`,
    `Plain fallback version, for reference only: ${job.fallback}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const res = await llm.chat.completions.create({
      model,
      max_tokens: 1024, // replies are ~60 tokens; headroom so a thinking model isn't cut off mid-sentence
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort as OpenAI.ReasoningEffort } : {}),
      messages: [
        { role: "system", content: `${SYSTEM}\n\n# Profile\n${profile || "(empty)"}` },
        { role: "user", content: prompt },
      ],
    });
    if (res.choices[0]?.finish_reason === "length") {
      console.warn("llm: reply cut off at the token limit (set LLM_REASONING_EFFORT=none for thinking models), using template");
      return job.fallback;
    }
    const text = res.choices[0]?.message?.content?.trim();
    if (!text) {
      console.warn("llm: empty reply, using template");
      return job.fallback;
    }
    const problem = checkDraft(text, job.must, `${facts}\n${profile}`, job.mustNumbers);
    if (problem) {
      console.warn(`llm: rejected draft (${problem}):`, text);
      return job.fallback;
    }
    console.log(`llm: ${model} wrote it`);
    return text;
  } catch (err) {
    console.error("llm: call failed, using template:", err instanceof Error ? err.message : err);
    return job.fallback;
  }
}

export function nudge(level: Level, s: Stats, recent: string[]) {
  const remaining = s.target - s.done;
  const step = nextStep(s.target, s.done, s.minsPerUnit);
  const facts = [
    `goal: ${s.id}`,
    `why it matters: ${s.why}`,
    `done today: ${s.done}/${s.target}`,
    `next small step (lead with this): do ${step.units} now, ~${step.mins} min. This is only a first chunk, NOT what's left.`,
    `total still left today: ${remaining} (background only; never call the small step "what's left")`,
    `window time left today (${fmtWin(s.windows)}): ${fmtLeft(s.minsLeft)}`,
    `urgency: ${level} (soft = slightly behind pace, firm = clearly behind, last = final hour)`,
    `reminders already sent about this goal today: ${s.pingsToday}`,
  ];
  if (s.streak > 0) facts.push(`current streak: ${s.streak} days, breaks if today is missed`);
  // Only set at last call. Mention it once, calmly, as information, not as a threat.
  if (s.warnPartner) facts.push(`if the goal is still unmet when today's last window closes, ${s.warnPartner} gets a note. /excuse <reason> lets them explain first.`);

  return write({
    reader: "user",
    task: "Nudge the user to make progress on this goal right now: name where they are, then the next small step.",
    facts,
    must: [`${s.done}/${s.target}`, ...(s.warnPartner ? ["/excuse"] : [])],
    recent,
    fallback: template(level, s),
  });
}

export function partnerNudge(p: Miss, recent: string[]) {
  const facts = [
    `the user: ${p.me}`,
    `goal: ${p.label}`,
    `why it matters to ${p.me}: ${p.why}`,
    `done today: ${p.done} of ${p.target} ${p.label} (day's window closed, goal missed)`,
    `missed days in a row: ${p.misses}`,
  ];
  if (p.brokenStreak > 0) facts.push(`streak that just broke: ${p.brokenStreak} days`);
  facts.push(p.reason ? `${p.me}'s excuse: "${p.reason}"` : "no excuse given");

  return write({
    reader: "partner",
    task: `Message ${p.partner}, ${p.me}'s accountability partner, that ${p.me} missed this goal today. You are talking TO ${p.partner}, about ${p.me}. Use what the profile says about ${p.partner} and their relationship. Get ${p.partner} to check in on ${p.me}. Teasing about ${p.me} is fine, never mean. The partner doesn't see the bot's stats, so say what happened in plain words with the real numbers (like "${p.me} did only ${p.done} of ${p.target} ${p.label} today"), never a bare fraction like ${p.done}/${p.target}.`,
    facts,
    must: [p.me],
    mustNumbers: [p.done, p.target],
    recent,
    fallback: partnerTemplate(p),
  });
}

type DayLine = {
  id: string;
  target: number;
  windows: Range[];
  done: number;
  streak: number;
  yesterday?: number; // morning only
  partnerTold?: boolean; // recap only
};

const fire = (n: number) => (n > 0 ? ` · 🔥 ${n}d` : "");

export function morningPlan(lines: DayLine[], recent: string[]) {
  const fallback = `☀️ Today:\n${lines.map((l) => `• ${l.id}: ${l.target} (${fmtWin(l.windows)})${fire(l.streak)}`).join("\n")}`;
  return write({
    reader: "user",
    task: "Send the user their morning plan: every goal with its target and time windows as a short list (one line each). Put one punchy opening line on top, based on yesterday's results and the profile: call out what they missed yesterday, or hype a streak.",
    facts: lines.map(
      (l) => `goal ${l.id}: target ${l.target}, window ${fmtWin(l.windows)}, yesterday ${l.yesterday ?? 0}/${l.target}, current streak ${l.streak} days`,
    ),
    must: lines.map((l) => l.id),
    recent,
    fallback,
  });
}

export function nightRecap(lines: DayLine[], recent: string[], partner: string) {
  const mark = (l: DayLine) => (l.done >= l.target ? "✅" : "❌");
  const told = (l: DayLine) => (l.partnerTold ? ` · 📣 ${partner} told` : "");
  const fallback = `🌙 Day recap:\n${lines.map((l) => `${mark(l)} ${l.id}: ${l.done}/${l.target}${fire(l.streak)}${told(l)}`).join("\n")}`;
  return write({
    reader: "user",
    task: "Send the user a short end-of-day recap: each goal's result as a list (one line each), then one honest line judging the day in your persona, and what tomorrow needs.",
    facts: lines.map(
      (l) =>
        `goal ${l.id}: ${l.done}/${l.target} (${l.done >= l.target ? "met" : "missed"}), streak now ${l.streak} days${l.partnerTold ? `, ${partner} was told about the miss` : ""}`,
    ),
    must: lines.map((l) => `${l.done}/${l.target}`),
    recent,
    fallback,
  });
}

export function toldNudge(p: { partner: string; id: string; done: number; target: number }, partnerMsg: string) {
  return write({
    reader: "user",
    task: `Tell the user you just reported their missed goal to ${p.partner}. Say it plainly and kindly, no gloating, then give one small first step for tomorrow. Paraphrase what they were told in your own voice for the user; don't copy its language or style.`,
    facts: [`goal: ${p.id}`, `done today: ${p.done}/${p.target}`, `what you sent ${p.partner}: "${partnerMsg}"`],
    must: [p.partner],
    recent: [],
    fallback: toldTemplate(p.partner, p.id),
  });
}

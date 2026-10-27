// Personal to-dos with Telegram reminders.
//
//   /todo call the bank @ tomorrow 9am     add, with a reminder
//   /todo renew domain                     add, no reminder (shows in the morning list)
//   /todos                                 open list
//   /done 3                                tick one off
//   /snooze 3 in 2h                        move a reminder
//
// Stored in %USERPROFILE%\.trinovata\todos.json, beside the bot token and
// outside Dev, so to-dos never land in a git repo or the vault.
//
// The bot calls sweep() every few minutes: each to-do whose time has come is
// sent once (with Done / +1h / Tomorrow buttons), and at MORNING_HOUR the open
// list is sent once a day. Times are this machine's local time.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const TODO_FILE = join(homedir(), ".trinovata", "todos.json");
export const MORNING_HOUR = 8;
const DEFAULT_HOUR = 9;

// ---- storage ---------------------------------------------------------------

export function load(file = TODO_FILE) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return { nextId: s.nextId ?? 1, items: Array.isArray(s.items) ? s.items : [], lastMorning: s.lastMorning ?? null };
  } catch {
    return { nextId: 1, items: [], lastMorning: null };
  }
}

// Write-then-rename so a crash mid-write never leaves half a file.
export function save(store, file = TODO_FILE) {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, file);
}

// ---- time parsing ----------------------------------------------------------

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// "9", "9am", "9:30pm", "21:15" -> [h, m] or null
function parseClock(s) {
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (!ap && !m[2] && h < 7) h += 12; // bare "3" means 3pm, not 3am
  if (h > 23 || min > 59) return null;
  return [h, min];
}

function at(base, [h, m]) {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Turns a phrase into a Date, or null if it is not understood.
 * Understands: in 20m / in 2h / in 3d, 9am / 21:30 (today, or tomorrow if it
 * has passed), today 5pm, tonight, tomorrow [time], mon..sun [time] (next one),
 * 2026-11-02 [time].
 */
export function parseWhen(input, now = new Date()) {
  const s = String(input ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;

  let m = s.match(/^in (\d+) ?(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2][0];
    const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
    return n > 0 ? new Date(now.getTime() + n * ms) : null;
  }

  if (s === "tonight") return at(now, [20, 0]) > now ? at(now, [20, 0]) : null;

  m = s.match(/^(today|tomorrow|tmrw|tmr)(?: (?:at )?(.+))?$/);
  if (m) {
    const clock = m[2] ? parseClock(m[2]) : [DEFAULT_HOUR, 0];
    if (!clock) return null;
    const base = new Date(now);
    if (m[1] !== "today") base.setDate(base.getDate() + 1);
    const d = at(base, clock);
    return d > now ? d : null;
  }

  m = s.match(/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*(?: (?:at )?(.+))?$/);
  if (m) {
    const clock = m[2] ? parseClock(m[2]) : [DEFAULT_HOUR, 0];
    if (!clock) return null;
    const target = DAYS.indexOf(m[1]);
    const base = new Date(now);
    let ahead = (target - now.getDay() + 7) % 7;
    if (ahead === 0 && at(base, clock) <= now) ahead = 7;
    base.setDate(base.getDate() + ahead);
    return at(base, clock);
  }

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?: (?:at )?(.+))?$/);
  if (m) {
    const clock = m[4] ? parseClock(m[4]) : [DEFAULT_HOUR, 0];
    if (!clock) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), clock[0], clock[1], 0, 0);
    return Number.isNaN(d.getTime()) || d <= now ? null : d;
  }

  const clock = parseClock(s.replace(/^at /, ""));
  if (clock) {
    const d = at(now, clock);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  return null;
}

export function formatWhen(iso, now = new Date()) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86_400_000);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  if (diff === -1) return `yesterday ${time}`;
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

// ---- operations (pure on the store; callers save) ---------------------------

const MAX_TEXT = 300;

export function addTodo(store, raw, now = new Date()) {
  const input = String(raw ?? "").trim();
  if (!input) return { error: "usage: /todo <what> [@ when]\ne.g. /todo call the bank @ tomorrow 9am" };
  const split = input.lastIndexOf(" @ ");
  let text = input;
  let due = null;
  if (split !== -1) {
    text = input.slice(0, split).trim();
    const whenText = input.slice(split + 3).trim();
    due = parseWhen(whenText, now);
    if (!due) return { error: `couldn't read "${whenText}" as a time. Try: in 2h, 5pm, tomorrow 9am, fri 10am, 2026-11-02 14:00` };
  }
  if (!text) return { error: "usage: /todo <what> [@ when]" };
  const item = {
    id: store.nextId++,
    text: text.slice(0, MAX_TEXT),
    created: now.toISOString(),
    due: due ? due.toISOString() : null,
    remindedAt: null,
    done: null,
  };
  store.items.push(item);
  return { item };
}

export function findOpen(store, id) {
  const n = Number(String(id ?? "").replace(/^#/, ""));
  return store.items.find(t => t.id === n && !t.done) ?? null;
}

export function completeTodo(store, id, now = new Date()) {
  const t = findOpen(store, id);
  if (!t) return { error: `no open to-do #${String(id ?? "").replace(/^#/, "") || "?"}. /todos lists them.` };
  t.done = now.toISOString();
  return { item: t };
}

export function snoozeTodo(store, id, whenText, now = new Date()) {
  const t = findOpen(store, id);
  if (!t) return { error: `no open to-do #${String(id ?? "").replace(/^#/, "") || "?"}. /todos lists them.` };
  const due = parseWhen(whenText, now);
  if (!due) return { error: `couldn't read "${whenText}" as a time. Try: in 1h, 5pm, tomorrow 9am` };
  t.due = due.toISOString();
  t.remindedAt = null;
  return { item: t };
}

export function openItems(store) {
  // Dated first (soonest first), then undated in the order added.
  return store.items
    .filter(t => !t.done)
    .sort((a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : a.id - b.id));
}

export function listText(store, now = new Date()) {
  const open = openItems(store);
  if (!open.length) return "✅ No open to-dos. Add one with /todo <what> [@ when]";
  const lines = [`📝 To-dos (${open.length})`, ""];
  for (const t of open) {
    const late = t.due && new Date(t.due) <= now ? " ⚠️" : "";
    lines.push(`#${t.id} ${t.text}${t.due ? `  · ${formatWhen(t.due, now)}${late}` : ""}`);
  }
  lines.push("", "/done <n> · /snooze <n> <when>");
  return lines.join("\n");
}

/** Items to remind about now; marks them reminded. Caller saves when non-empty. */
export function takeDue(store, now = new Date()) {
  const due = store.items.filter(t => !t.done && t.due && !t.remindedAt && new Date(t.due) <= now);
  for (const t of due) t.remindedAt = now.toISOString();
  return due;
}

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The morning list, once a day from MORNING_HOUR, only if anything is open. */
export function takeMorning(store, now = new Date()) {
  if (now.getHours() < MORNING_HOUR) return null;
  const today = localDate(now);
  if (store.lastMorning === today) return null;
  store.lastMorning = today;
  if (!openItems(store).length) return null;
  return `☀️ Good morning\n\n${listText(store, now)}`;
}

// Inline buttons on a reminder. Callback data stays well under Telegram's 64 bytes.
export function reminderMarkup(id) {
  return {
    inline_keyboard: [[
      { text: "✅ Done", callback_data: `todo:done:${id}` },
      { text: "⏰ +1h", callback_data: `todo:snooze:${id}:in 1h` },
      { text: "📅 Tomorrow", callback_data: `todo:snooze:${id}:tomorrow` },
    ]],
  };
}

// ---- Telegram glue (file I/O lives here, not in the operations) -------------

export function routeTodoCommand(cmd, arg, file = TODO_FILE, now = new Date()) {
  if (!["todo", "todos", "done", "snooze"].includes(cmd)) return null;
  const store = load(file);
  if (cmd === "todos") return { text: listText(store, now) };
  if (cmd === "todo") {
    if (!arg) return { text: listText(store, now) };
    const r = addTodo(store, arg, now);
    if (r.error) return { text: r.error };
    save(store, file);
    return { text: `📝 #${r.item.id} added${r.item.due ? ` · reminder ${formatWhen(r.item.due, now)}` : ""}` };
  }
  if (cmd === "done") {
    const r = completeTodo(store, arg, now);
    if (r.error) return { text: r.error };
    save(store, file);
    return { text: `✅ #${r.item.id} done: ${r.item.text}` };
  }
  const [id, ...rest] = arg.split(/\s+/);
  const r = snoozeTodo(store, id, rest.join(" "), now);
  if (r.error) return { text: rest.length ? r.error : "usage: /snooze <n> <when>  e.g. /snooze 3 in 2h" };
  save(store, file);
  return { text: `⏰ #${r.item.id} moved to ${formatWhen(r.item.due, now)}` };
}

export function routeTodoCallback(data, file = TODO_FILE, now = new Date()) {
  if (!data.startsWith("todo:")) return null;
  const [, action, id, ...rest] = data.split(":");
  if (action === "done") return routeTodoCommand("done", id, file, now);
  if (action === "snooze") return routeTodoCommand("snooze", `${id} ${rest.join(":")}`, file, now);
  return null;
}

/** One sweep: returns messages to send. Saves only if something changed. */
export function sweep(file = TODO_FILE, now = new Date()) {
  const store = load(file);
  const out = [];
  for (const t of takeDue(store, now)) {
    out.push({ text: `⏰ Reminder #${t.id}\n${t.text}`, markup: reminderMarkup(t.id) });
  }
  const before = store.lastMorning;
  const morning = takeMorning(store, now);
  if (morning) out.push({ text: morning });
  if (out.length || store.lastMorning !== before) save(store, file);
  return out;
}

// node --test todos.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseWhen, addTodo, completeTodo, snoozeTodo, takeDue, takeMorning, listText,
  routeTodoCommand, routeTodoCallback, sweep, load,
} from "./todos.mjs";

// Wednesday 28 Oct 2026, 10:00 local.
const NOW = new Date(2026, 9, 28, 10, 0, 0);
const empty = () => ({ nextId: 1, items: [], lastMorning: null });
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "todos-")), "todos.json");
const hm = d => [d.getDate(), d.getHours(), d.getMinutes()];

test("parseWhen: relative, clock, day words, weekdays, dates", () => {
  assert.equal(parseWhen("in 2h", NOW).getTime(), NOW.getTime() + 2 * 3_600_000);
  assert.equal(parseWhen("in 30 min", NOW).getTime(), NOW.getTime() + 30 * 60_000);
  assert.deepEqual(hm(parseWhen("5pm", NOW)), [28, 17, 0]);
  assert.deepEqual(hm(parseWhen("9am", NOW)), [29, 9, 0], "passed today, so tomorrow");
  assert.deepEqual(hm(parseWhen("3", NOW)), [28, 15, 0], "bare 3 is 3pm");
  assert.deepEqual(hm(parseWhen("tomorrow", NOW)), [29, 9, 0]);
  assert.deepEqual(hm(parseWhen("tomorrow at 7:30pm", NOW)), [29, 19, 30]);
  assert.deepEqual(hm(parseWhen("fri 10am", NOW)), [30, 10, 0]);
  assert.deepEqual(hm(parseWhen("wed 9am", NOW)), [4, 9, 0], "this Wednesday has passed, so next week");
  assert.deepEqual(hm(parseWhen("2026-11-02 14:00", NOW)), [2, 14, 0]);
  assert.deepEqual(hm(parseWhen("tonight", NOW)), [28, 20, 0]);
});

test("parseWhen: rejects nonsense and the past", () => {
  for (const s of ["", "soon", "in 0h", "25:00", "today 9am", "2020-01-01", "tomorrow blah"]) {
    assert.equal(parseWhen(s, NOW), null, s);
  }
});

test("addTodo splits on the last ' @ ' and keeps @ inside the text", () => {
  const store = empty();
  const r = addTodo(store, "email ana@x.com @ in 1h", NOW);
  assert.equal(r.item.text, "email ana@x.com");
  assert.equal(r.item.due, new Date(NOW.getTime() + 3_600_000).toISOString());
  assert.equal(addTodo(store, "plain", NOW).item.due, null);
  assert.match(addTodo(store, "x @ whenever", NOW).error, /couldn't read/);
  assert.match(addTodo(store, "", NOW).error, /usage/);
  assert.equal(store.items.length, 2, "failed adds are not stored");
});

test("reminders fire once, snooze re-arms, done stops them", () => {
  const store = empty();
  addTodo(store, "call bank @ in 1h", NOW);
  addTodo(store, "no date", NOW);
  const later = new Date(NOW.getTime() + 61 * 60_000);
  assert.equal(takeDue(store, NOW).length, 0);
  assert.deepEqual(takeDue(store, later).map(t => t.id), [1]);
  assert.equal(takeDue(store, later).length, 0, "not sent twice");
  snoozeTodo(store, 1, "in 1h", later);
  assert.equal(takeDue(store, new Date(later.getTime() + 61 * 60_000)).length, 1);
  completeTodo(store, 1, later);
  assert.match(completeTodo(store, 1, later).error, /no open to-do #1/);
});

test("morning list: once a day, from 8am, only when something is open", () => {
  const store = empty();
  const early = new Date(2026, 9, 28, 7, 59);
  const eight = new Date(2026, 9, 28, 8, 1);
  assert.equal(takeMorning(store, eight), null, "nothing open");
  store.lastMorning = null;
  addTodo(store, "thing", early);
  assert.equal(takeMorning(store, early), null, "before 8");
  assert.match(takeMorning(store, eight), /Good morning[\s\S]*#1 thing/);
  assert.equal(takeMorning(store, new Date(2026, 9, 28, 15, 0)), null, "already sent today");
  assert.ok(takeMorning(store, new Date(2026, 9, 29, 8, 0)), "next day");
});

test("listText marks overdue items and sorts dated first", () => {
  const store = empty();
  addTodo(store, "undated", NOW);
  addTodo(store, "later @ in 3h", NOW);
  addTodo(store, "sooner @ in 1h", NOW);
  const text = listText(store, new Date(NOW.getTime() + 2 * 3_600_000));
  const order = text.split("\n").filter(l => l.startsWith("#")).map(l => l.split(" ")[0]);
  assert.deepEqual(order, ["#3", "#2", "#1"]);
  assert.match(text, /#3 sooner .*⚠️/);
});

test("commands and buttons persist to the file", () => {
  const file = tmpFile();
  assert.match(routeTodoCommand("todo", "pay rent @ fri 10am", file, NOW).text, /#1 added · reminder Fri/);
  assert.match(routeTodoCommand("todos", "", file, NOW).text, /#1 pay rent/);
  assert.equal(routeTodoCommand("help", "", file, NOW), null, "other commands fall through");
  const snoozed = routeTodoCallback("todo:snooze:1:in 1h", file, NOW);
  assert.match(snoozed.text, /#1 moved to today 11:00/);
  assert.match(routeTodoCallback("todo:done:1", file, NOW).text, /done: pay rent/);
  assert.equal(load(file).items[0].done, NOW.toISOString());
  assert.equal(routeTodoCallback("confirm:triage", file, NOW), null);
});

test("sweep sends due reminders with buttons and saves", () => {
  const file = tmpFile();
  routeTodoCommand("todo", "stretch @ in 5m", file, NOW);
  const out = sweep(file, new Date(NOW.getTime() + 6 * 60_000));
  assert.equal(out.length, 2, "reminder + morning list (it is after 8am)");
  assert.match(out[0].text, /Reminder #1\nstretch/);
  assert.equal(out[0].markup.inline_keyboard[0][0].callback_data, "todo:done:1");
  assert.equal(sweep(file, new Date(NOW.getTime() + 7 * 60_000)).length, 0);
  assert.ok(JSON.parse(readFileSync(file, "utf8")).items[0].remindedAt);
});

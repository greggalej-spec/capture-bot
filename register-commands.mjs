#!/usr/bin/env node
// Push the command list to Telegram's native "/" menu, so typing "/" on the
// phone shows every command with its description instead of requiring Gregg to
// remember them.
//
// The list comes from COMMANDS in commands.mjs — the same array /help renders
// from — so the menu and the help text cannot disagree.
//
// Run once after changing COMMANDS:  node register-commands.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { COMMANDS } from "./commands.mjs";

const CFG = join(homedir(), ".trinovata");
const env = readFileSync(join(CFG, "capture-bot.env"), "utf8");
const token = (env.match(/^BOT_TOKEN=(.+)$/m) || [])[1]?.trim();
if (!token) { console.error("BOT_TOKEN not found"); process.exit(1); }

// Telegram: command must be lowercase, 1-32 chars, [a-z0-9_]; description 1-256.
const commands = COMMANDS.map(c => ({
  command: c.cmd.toLowerCase().slice(0, 32),
  description: c.desc.slice(0, 256),
}));

const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ commands }),
});
const body = await res.json();
if (!body.ok) { console.error(`setMyCommands failed: ${body.description}`); process.exit(1); }
console.log(`registered ${commands.length} commands in Telegram's menu:`);
for (const c of commands) console.log(`  /${c.command} — ${c.description}`);

#!/usr/bin/env node
// Push a milestone update to the owner chat — outbound half of the capture bot.
//
// Two shapes, deliberately:
//   PING    a short TL;DR sent the moment a milestone completes. This is what
//           Gregg actually reads on a phone.
//   DETAIL  the long version, written to disk and NOT sent. Pulled on demand
//           with /expand in Telegram.
//
// The split exists because a long agent run produces a lot worth keeping and
// very little worth interrupting someone for. Sending everything trains you to
// ignore the channel; sending only a headline loses the evidence. Storing the
// detail keeps both.
//
// Usage:
//   node notify.mjs "quick message"                          # plain ping
//   node notify.mjs --tldr "Fixed the hook" --detail out.md   # ping + stored detail
//   node notify.mjs --tldr "..." --detail out.md --id hook-fix
//   echo "msg" | node notify.mjs                              # ping from stdin
//   node notify.mjs --file report.md                          # send a file as-is
//
// Detail bodies live in %USERPROFILE%\.trinovata\updates\<id>.md alongside an
// index.json. Reads the bot token from capture-bot.env and the chat id from
// capture-bot-state.json, so it can only ever message the locked owner.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CFG = join(homedir(), ".trinovata");
const UPDATES = join(CFG, "updates");
const INDEX = join(UPDATES, "index.json");

function token() {
  const env = readFileSync(join(CFG, "capture-bot.env"), "utf8");
  const m = env.match(/^BOT_TOKEN=(.+)$/m);
  if (!m) throw new Error("BOT_TOKEN not found in capture-bot.env");
  return m[1].trim();
}

function ownerChat() {
  const s = JSON.parse(readFileSync(join(CFG, "capture-bot-state.json"), "utf8"));
  if (!s.ownerChatId) throw new Error("no ownerChatId yet — message the bot once first");
  return s.ownerChatId;
}

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve("");
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c));
    process.stdin.on("end", () => resolve(d));
    process.stdin.on("error", () => resolve(d));
  });
}

// Telegram hard-caps a message at 4096 chars. Split on line boundaries so a
// table or list is never cut mid-row.
function chunk(text, limit = 3900) {
  const out = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf.length + line.length + 1 > limit) {
      if (buf) out.push(buf);
      buf = line.length > limit ? line.slice(0, limit) : line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : ["(empty)"];
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "update";
}

// The index is the newest-first list /updates renders. Capped so it stays a
// useful recent history rather than an archive nobody scrolls.
function saveDetail(id, tldr, detail) {
  mkdirSync(UPDATES, { recursive: true });
  writeFileSync(join(UPDATES, `${id}.md`), detail, "utf8");
  let index = [];
  try { index = JSON.parse(readFileSync(INDEX, "utf8")); } catch {}
  index = index.filter(e => e.id !== id);
  index.unshift({ id, tldr, ts: new Date().toISOString() });
  writeFileSync(INDEX, JSON.stringify(index.slice(0, 50), null, 2), "utf8");
}

async function send(text) {
  const api = `https://api.telegram.org/bot${token()}/sendMessage`;
  const chat_id = ownerChat();
  let sent = 0;
  for (const part of chunk(text)) {
    const res = await fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No parse_mode: agent output contains underscores, asterisks and brackets
      // that would break Markdown parsing or silently swallow characters.
      body: JSON.stringify({ chat_id, text: part, disable_web_page_preview: true }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(`telegram: ${body.description}`);
    sent++;
  }
  return sent;
}

async function main() {
  const argv = process.argv.slice(2);
  const val = flag => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : null; };

  const tldr = val("--tldr");
  const detailPath = val("--detail");
  const filePath = val("--file");

  // Plain send: --file, inline text, or stdin. Unchanged behaviour.
  if (!tldr) {
    let text = filePath ? readFileSync(filePath, "utf8")
      : argv.filter(a => !a.startsWith("--") && a !== filePath).join(" ") || (await readStdin());
    if (!text.trim()) {
      console.error('usage: node notify.mjs "msg" | --tldr "..." --detail <file> | --file <path>');
      process.exit(1);
    }
    console.log(`sent ${await send(text)} message(s)`);
    return;
  }

  // Milestone ping + stored detail.
  const id = val("--id") || slugify(tldr);
  const detail = detailPath ? readFileSync(detailPath, "utf8") : (await readStdin());
  if (detail.trim()) saveDetail(id, tldr, detail);

  const ping = detail.trim()
    ? `${tldr}\n\n→ /expand ${id}`
    : tldr;
  await send(ping);
  console.log(`pinged: ${tldr}${detail.trim() ? `  (detail stored as ${id})` : ""}`);
}

main().catch(e => { console.error(`notify failed: ${e.message}`); process.exit(1); });

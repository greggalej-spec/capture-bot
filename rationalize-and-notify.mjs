#!/usr/bin/env node
// Run the rationalization harness, then push the verdict to Telegram.
//
// Exists so /add can return instantly: the chat command spawns this detached and
// replies "working on it", and the verdict arrives as its own message minutes
// later. Without the split, Telegram's handler would block for the length of a
// full Claude run and the bot would look dead.
//
// Usage: node rationalize-and-notify.mjs "<idea>"
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const idea = process.argv.slice(2).join(" ").trim();

if (!idea) {
  console.error('usage: node rationalize-and-notify.mjs "<idea>"');
  process.exit(1);
}

function run(script, args) {
  return new Promise((resolve, reject) => {
    let out = "";
    const child = execFile(process.execPath, [join(HERE, script), ...args], {
      windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 900_000,
    }, err => (err && !out ? reject(err) : resolve(out)));
    child.stdout?.on("data", d => (out += d));
    child.stderr?.on("data", d => process.stderr.write(d));
  });
}

const verdictLine = t => (t.match(/VERDICT:\s*(\w+)/i) || [, "UNCLEAR"])[1].toUpperCase();
const field = (t, name) => {
  const m = t.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return m ? m[1].trim() : null;
};

try {
  const out = await run("rationalize.mjs", [idea]);
  const verdict = verdictLine(out);
  const emoji = { BUILD: "🟢", STAGE: "🟡", FOLD: "🔵", REJECT: "🔴", UNCLEAR: "⚪" }[verdict] || "⚪";
  const id = (out.match(/^[🟢🟡🔵🔴⚪]\s+\w+\s+—\s+(\S+)/m) || [, null])[1];

  // The ping carries the decision and the next step — the two things worth
  // reading on a phone. Everything else waits behind /proposal.
  const tldr = [
    `${emoji} ${verdict} — ${field(out, "ONE-LINER") || idea.slice(0, 90)}`,
    ``,
    field(out, "ALREADY EXISTS") ? `Exists: ${field(out, "ALREADY EXISTS").slice(0, 180)}` : null,
    field(out, "COST") ? `Cost: ${field(out, "COST").slice(0, 120)}` : null,
    field(out, "NEXT ACTION") ? `Next: ${field(out, "NEXT ACTION").slice(0, 180)}` : null,
    ``,
    id ? `→ /proposal ${id}` : `→ /proposals`,
  ].filter(l => l !== null).join("\n");

  await run("notify.mjs", [tldr]);
  console.log(`verdict ${verdict} sent`);
} catch (e) {
  try { await run("notify.mjs", [`⚠️ The rationalization harness failed: ${e.message}`]); } catch {}
  console.error(`failed: ${e.message}`);
  process.exit(1);
}

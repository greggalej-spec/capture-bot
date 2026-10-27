# capture-bot — phone → vault pipeline + contextual Q&A + remote control

**Four modes per message:**
- **Capture (default):** send anything; it lands in the vault inbox (below), "captured ✓".
- **Quick action (`/command`, or tap a button):** see below — the bot as a remote
  control for the machine.
- **Owner directive (`!` prefix):** `!integrate these as individual ventures` is
  captured with `origin: owner-directive` frontmatter. That marker is the **only**
  thing that lets the pipeline treat capture content as an instruction rather than
  as data — it's trustworthy because the chat is owner-locked, not because the
  text looks authoritative. Anything the directive quotes stays untrusted.
- **Ask (`?` or `/ask` prefix):** `?what's the Juniper House status` → a headless
  Claude session runs from the Dev root (inherits CLAUDE.md, memory, vault-pulse
  context) and replies in Telegram. One persistent conversation thread — follow-up
  `?…` questions remember the previous ones (`--resume`). One question at a time;
  10-minute timeout; **each answer is a real Claude run and costs credits.**
  Runs with acceptEdits (can edit files, cannot run un-allowlisted commands).

Send anything to a private Telegram bot; it lands in
`Dev\Research\vault\inbox\telegram\new\` within seconds (media downloaded to
`attachments\`), you get a "captured ✓" reply, and ingestion happens adaptively:

- **Claude session active on this PC** → captures wait in the inbox; the
  `vault-pulse` SessionStart hook surfaces the count, and any session ingests
  per the SOP.
- **No session active** → after a quiet period (default 10 min, batching a
  burst of messages), the bot spawns a headless `claude -p` ingest that runs
  the vault SOP and moves processed captures to `archived\`.
- **PC offline** → messages queue on Telegram's servers (~24h retention for
  unfetched updates) and drain when the poller returns. Older than that: the
  chat history on your phone is the fallback — resend if needed.

## Quick actions (remote control)

Send `/menu` for tappable buttons, or type the command. Handlers live in
`commands.mjs`. Unknown `/commands` fall through and are captured as normal, so
adding one here never silently swallows a message.

**Read — instant, free**

| Command | Answers |
|---|---|
| `/status` | capture counts: sent · synthesized · mid-pipeline · awaiting, by day |
| `/health` | RAM/VRAM against the 70% cap, whether a Claude session is live, loaded local models |
| `/git` | unpushed commits and dirty trees across the repos where loss would hurt |
| `/events` | recent recorded actions from the event ledger |
| `/questions` | open items from `sources/to-review.md` — the "send questions" half of directive D5 |
| `/find <text>` | which vault notes mention it |
| `/skill <need>` | what capability already exists (queries the skill registry) |
| `/local <prompt>` | ask the local model — free, and works when cloud limits are hit |
| `/help` | the list |

**Run — confirm-gated**

| Command | Does |
|---|---|
| `/triage` | processes waiting captures via the standing pipeline |
| `/scrape` | runs the GitHub research sweep now |

Both spawn real work that costs credits or CPU, so they ask before running. A
mis-tap on a phone must not launch a 24-agent fleet — that is the whole reason
for the confirm step.

**Safety notes.** Button presses are accepted only from the locked owner chat.
No handler passes free-form text into a shell: arguments go to `execFile` as an
argv array, never concatenated into a command line. Every reply is chunked to
Telegram's 4096-character limit.

## One-time setup

1. In Telegram: message **@BotFather** → `/newbot` → pick a name (e.g.
   "Trinovata Capture") → copy the token.
2. Put the token in `%USERPROFILE%\.trinovata\capture-bot.env` (NEVER inside Dev):
   ```
   BOT_TOKEN=123456:ABC-your-token
   AUTO_INGEST=1
   INGEST_QUIET_MINUTES=10
   ```
3. **Auto-start is already wired** — via a Startup-folder launcher, NOT schtasks.
   `schtasks /Create` was attempted first and failed with *Access is denied*
   (needs elevation), so the working mechanism is:
   ```
   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\trinovata-capture-bot.vbs
   ```
   It launches `node capture-bot.mjs` hidden at logon. **Delete that file to
   disable autostart.** Verify it's running:
   ```powershell
   Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'capture-bot' } | Select ProcessId
   ```
   To restart after editing the source:
   ```powershell
   Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'capture-bot' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   wscript "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\trinovata-capture-bot.vbs"
   ```
4. Send the bot any message. The **first chat** that messages it becomes the
   locked owner (stored in `capture-bot-state.json`); all other chats are
   refused. You should get the "armed" reply, then "captured ✓" per message.

## Ops

- Log: `%USERPROFILE%\.trinovata\capture-bot.log` · headless-ingest logs: `ingest-*.log` alongside.
- Stop/start: see the restart commands in step 3.
- **Headless ingest** runs `claude -p` with `acceptEdits` but **`cwd` is the vault,
  not the Dev root**, and `Bash`, `WebFetch` and `WebSearch` are denied. It can
  write notes; it cannot reach `_archive/`, `.claude/hooks/`, or a product repo.
- **The `?ask` path is READ-ONLY** — `--permission-mode plan`, `Bash`/`Write`/
  `Edit` denied, no resumed session. It can answer; it cannot change anything.
- Security posture and its known gaps: `SECURITY.md` in this folder.
- **Verified behaviour vs claims:** the idle-ingest branch has **never actually
  fired** — every debounce so far found a live Claude session and deferred to it
  (11 log entries). Treat "idle ingest" as implemented-but-unproven until a log
  line says `spawning headless ingest`.
- Captures are never deleted: ingest moves them `new\` → `archived\`.
- Security: no shell interpolation anywhere; capture text never enters a command
  line; the bot token stays outside Dev in `~\.trinovata\`.

## To-dos and reminders

Personal to-dos live in `%USERPROFILE%\.trinovata\todos.json` (outside Dev, never committed).

| Command | What it does |
|---|---|
| `/todo call the bank @ tomorrow 9am` | Add a to-do with a reminder |
| `/todo renew domain` | Add a to-do with no reminder |
| `/todos` | Open list, overdue items marked |
| `/done 3` | Tick off #3 |
| `/snooze 3 in 2h` | Move #3's reminder |

Times: `in 20m`, `in 2h`, `in 3d`, `5pm`, `21:30`, `today 5pm`, `tonight`, `tomorrow [time]`,
`fri [time]`, `2026-11-02 14:00`. A bare day defaults to 9am. Machine local time.

The bot checks every 5 minutes. A due to-do is sent once with ✅ Done / ⏰ +1h / 📅 Tomorrow
buttons, and from 8am the open list is sent once a day. Reminders need the bot running,
so they arrive when this PC is on. Tests: `node --test todos.test.mjs`.
After changing commands, run `node register-commands.mjs` to update Telegram's "/" menu.

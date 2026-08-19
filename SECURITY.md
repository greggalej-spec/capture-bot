# capture-bot — security posture

Audited 2026-08-13. This file records what the boundaries actually are, so a
future change doesn't quietly remove one.

## The threat

Captured content is **arbitrary text from the internet** — forwarded social posts,
article bodies, READMEs. When no Claude session is running, the bot spawns a
headless `claude -p` that reads it. That is a prompt-injection surface, and the
`?ask` path is a second one.

## Boundaries (enforced by flags, not by asking nicely)

| Path | Boundary |
|---|---|
| **`?ask`** | `--permission-mode plan` (read-only) · `--disallowedTools Bash,Write,Edit,NotebookEdit` · question framed after a `===QUESTION===` marker · **no `--resume`** |
| **Ingest** | `cwd` = the **vault**, not the Dev root · `--disallowedTools Bash,WebFetch,WebSearch` · trust-boundary paragraph in the prompt |
| **Both** | `shell: false`, argv arrays — capture text never reaches a shell |

**Why `--resume` was removed from `?ask`** (audit finding C2): a resumed session
carries an injected instruction into *every* future question. One successful
injection became standing compromise. Each question now starts clean.

**Why ingest's `cwd` is the vault** (finding H1): at the Dev root, an injected
instruction could reach `_archive/` (which holds 37 `.env` files), `.claude/hooks/`
(hook files execute on the next session — the `acceptEdits`→execution bridge), and
every product repo. Scoped to the vault, the blast radius is notes.

**The prompt paragraph is not the boundary.** It is defence in depth. The thing
enforcing a prompt instruction is the same model being attacked; the flags are
what actually hold.

## Input sanitisation (`sanitizeBody`)

Applied before anything is written to disk:
- Control characters stripped (except `\n`, `\t`)
- Zero-width and bidi-override characters stripped — these hide text from a human reviewer
- **Credential-bearing query parameters redacted** (`mcp_token`, `access_token`,
  `api_key`, `token`, `signature`, …), plain and URL-encoded. Added after a live
  JWT was captured into the vault from a share link (finding M1)
- Capped at 40,000 characters
- The payload is fenced with a backtick run **longer than any run inside it**
  (CommonMark rule) so content is never mutated *and* can never break out of its fence
- Filenames from Telegram: path separators, traversal, and reserved characters neutralised

Every action taken is reported in the note (`_Sanitizer: …_`) so a reader can see
what was changed.

## Known weaknesses — not yet fixed

- **Owner lock is trust-on-first-use and keys on `chat.id`, not `from.id`.** If
  `capture-bot-state.json` were deleted, the next chat to message claims ownership.
  If the owner chat were ever a group, every member is trusted.
  *Fix:* pin `OWNER_USER_ID` in `~/.trinovata/capture-bot.env` and check `msg.from.id`.
- **No volume rate limit.** `askBusy` serialises questions but bounds nothing.
  The capture path accepts unlimited messages and unbounded media downloads
  (`downloadMedia` has no size cap).
  *Fix:* per-minute message cap, daily ingest-spawn cap, media size ceiling.
- **No dry-run mode.** `INGEST_DRY_RUN=1` spawning with `--permission-mode plan`
  and logging what it *wanted* to do would be worth running for a week.

## Verified clean

Long-polling (`getUpdates`) — no inbound port, no webhook to forge · `shell: false`
on both spawns · bot token stored outside Dev in `~/.trinovata/` · only
`allowed_updates: ["message"]`, so edited messages can't force reprocessing.

*Full audit: the 2026-08-13 security pass. Open items for Gregg are tracked in
`TrinovataVault/04 Builds/DECISIONS-WAITING.md`.*

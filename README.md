# Multi-Session WhatsApp Channel for Claude Code

One WhatsApp line, many Claude Code terminals. Route replies to the right project by `<N>` session number, `#tag` address, `!all` broadcast, or quote-reply — all through a single WhatsApp linked-device slot. Idle sessions are woken on each inbound via a `Monitor` tailing a meta-only inbox log.

A fork of [`diogo85/claude-code-whatsapp`](https://github.com/diogo85/claude-code-whatsapp), split into a persistent daemon plus a thin per-session MCP client.

> **Why a fork?** WhatsApp caps linked devices at 4. Running upstream's single-session plugin in more than a couple of Claude terminals at once knocks older sessions offline. This fork keeps one Baileys connection in a daemon and fans messages out to N Claude sessions over a local Unix socket — so any number of Claude sessions share a single WhatsApp slot.

## Architecture

```
Phone (WhatsApp)
    ↕  WhatsApp Web Multi-Device (Baileys v7)
wa-daemon.cjs              ← persistent, single connection, managed by launchd
    ↕  /tmp/claude-wa.sock (JSON-line IPC)
session-client.cjs         ← thin MCP stdio subprocess, one per Claude session
    ├─ emits notifications/claude/channel          ← host-supported injection
    └─ appends meta-only line to inbox-<tag>.log   ← Monitor-based delivery
    ↕
Claude Code (e.g. in ~/Work/polybillionaire)
```

### Two delivery paths

For every inbound, the session-client does both:

1. **Emits `notifications/claude/channel`.** If Claude Code's host surfaces channel notifications as user turns, this is the preferred path.
2. **Appends one meta-only line** (chat_id, message_id, route, flags — *no content*) to `~/.claude/channels/whatsapp/inbox-<tag>.log`. The `/connect-wa` skill starts a persistent `Monitor` that tails this log and emits each line as a chat notification, which wakes the session to reply.

In practice, path (2) is what wakes idle sessions reliably today. Message content is never written to disk — after being woken, the session calls `fetch_messages` to read the body if needed.

## Routing model

**Outbound (Claude → phone).** Every reply is auto-prefixed with `[<N> <tag>]` where `<N>` is the daemon-assigned session number (1–99) and `<tag>` is `basename(cwd)`: `[1 polybillionaire] bot stopped out SOL`. Pass `prefix: false` to the `reply` tool to skip it.

**Inbound (phone → Claude).** The daemon classifies each incoming message in this order:

| Prefix                              | Routes to                                          |
|-------------------------------------|----------------------------------------------------|
| `<N> <message>`                     | session #N (1–99, daemon-assigned)                 |
| `#<tag> <message>`                  | session(s) whose tag matches (prefix, case-insens) |
| `!all`                              | every session — one-line "what I'm working on" status |
| `!all <message>`                    | broadcast `<message>` to every registered session  |
| *(quote-reply to tagged outbound)*  | session that sent the quoted message               |
| *(none of the above)*               | the **active** session (most recent `/connect-wa`) |

If nothing matches, the daemon reacts with ❓ on the phone and drops.

## Setup

### 1. Install

```bash
git clone <this fork's URL> ~/Work/claude-whatsapp-mcp
cd ~/Work/claude-whatsapp-mcp
npm install
```

Node 20+. Bun is not supported (Baileys depends on Node WebSocket events Bun doesn't emit).

### 2. Pair your WhatsApp account once

```bash
mkdir -p ~/.claude/channels/whatsapp/auth
WHATSAPP_STATE_DIR=~/.claude/channels/whatsapp npm run pair
# Scan the QR on your phone at WhatsApp > Linked Devices > Link a Device
# (Alternative: PAIR_PHONE=<E.164 number> for pairing-code flow)
```

Wait for `✅ WhatsApp connected!`. Creds land in `~/.claude/channels/whatsapp/auth/`.

### 3. Start the daemon

**Option A — launchd (recommended for 24/7):**

```bash
cp code.claude.whatsapp-daemon.plist ~/Library/LaunchAgents/
# Edit ~/Library/LaunchAgents/code.claude.whatsapp-daemon.plist
#   - ProgramArguments[1] → absolute path to wa-daemon.cjs
#   - WorkingDirectory    → this repo's absolute path
#   - WHATSAPP_STATE_DIR + log paths → absolute path to ~/.claude/channels/whatsapp
launchctl load ~/Library/LaunchAgents/code.claude.whatsapp-daemon.plist
```

**Option B — foreground for testing:**

```bash
WHATSAPP_STATE_DIR=~/.claude/channels/whatsapp npm run daemon
```

The session client auto-spawns the daemon (detached) if it finds `/tmp/claude-wa.sock` missing. Set `WA_AUTO_SPAWN=0` to disable.

### 4. Wire Claude Code to the MCP server

`.mcp.json` is **gitignored** — each host writes its own so absolute paths don't leak. Create one per project (or at `~/.claude/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/claude-whatsapp-mcp/session-client.cjs"]
    }
  }
}
```

### 5. Start Claude Code with the channel enabled

`server:` channels are experimental and require two flags. Put this in `~/.zshrc`:

```bash
alias cc='command claude --dangerously-skip-permissions --dangerously-load-development-channels --channels server:whatsapp'
alias claude='command claude --dangerously-load-development-channels --channels server:whatsapp'
```

Notes:
- `command claude` prevents zsh from recursively expanding the `claude` alias, which would otherwise duplicate `--channels server:whatsapp`.
- `--channels whatsapp` (bare) is rejected — must be `server:whatsapp` (or `plugin:<name>@<marketplace>` if installed as a plugin).

### 6. Claim a session

In each Claude Code terminal where you want WhatsApp delivery:

```
/connect-wa
```

This claims the session as the active untagged-reply target **and** starts a persistent `Monitor` that wakes the session on each inbound. The skill lives at `~/.claude/skills/connect-wa/SKILL.md` and is user-global — copy it into a new user shell if you set up a second machine. Sessions that don't run `/connect-wa` won't surface `#tag` or `!all` messages even though the daemon is routing to them.

## Skills

User-invocable slash commands installed to `~/.claude/skills/`:

| Command          | Purpose                                                                                  |
|------------------|------------------------------------------------------------------------------------------|
| `/connect-wa`    | Claim active + start Monitor. Do this in every session you want WhatsApp messages on.    |
| `/disconnect-wa` | Release the active-session claim; another registered session becomes the default target |
| `/wa-status`     | List every registered session, its number, and whether WhatsApp is connected            |

## MCP tools

| Tool                       | Description                                                       |
|----------------------------|-------------------------------------------------------------------|
| `reply`                    | Send text + file attachments (auto-prefixed with `[<N> <tag>]`)   |
| `react`                    | Emoji reaction on a message                                       |
| `download_attachment`      | Download media to `~/.claude/channels/whatsapp/inbox/`            |
| `fetch_messages`           | Recent messages for a chat (daemon cache)                         |
| `claim_active_session`     | Make this session the active untagged-reply target                |
| `release_active_session`   | Release the active claim                                          |
| `list_sessions`            | Every registered session, its number, and which is active         |

## Access control

`~/.claude/channels/whatsapp/access.json`:

```json
{
  "allowFrom": ["5511999999999"],
  "allowGroups": false,
  "allowedGroups": [],
  "requireAllowFromInGroups": false,
  "confirmToken": null
}
```

- `allowFrom: []` — accept from anyone (don't do this in production)
- `allowFrom: ["<E.164 number>"]` — only from your own number
- `confirmToken: "some-secret"` — optional. Inbound messages that start with the token get `meta.origin_confirmed="true"`; others get `"false"`. Claude sees this and treats destructive operations as pending approval unless confirmed.

Permission requests from Claude arrive on WhatsApp as:

```
🔐 [1 polybillionaire] Permission request [tbxkq]

Bash: rm -rf /tmp/foo

Reply "yes tbxkq" or "no tbxkq"
```

Reply from phone; Claude proceeds or stops. The plugin reacts ✅/❌ to confirm receipt.

## Security

This plugin lets anyone on your WhatsApp allowlist send prompts to Claude Code sessions with access to your codebase.

1. **Use `allowFrom`.** Empty = open relay. Don't.
2. **Secondary number recommended.** Use a Google Voice / second SIM for the bot account. Running on your primary number increases ban risk with any unofficial WhatsApp client.
3. **Destructive tools need confirmation.** Configure Claude Code's `allowedTools` to exclude `Write`, `Edit`, `Bash(destructive)` by default — those trigger permission relay to the phone. Set `confirmToken` for an extra password-gate hint.
4. **Origin tagging.** Every WhatsApp-sourced channel message has `meta.origin="whatsapp"` so Claude can distinguish it from terminal input.
5. **Kill switch.** `touch ~/.claude/channels/whatsapp/PANIC` — daemon polls this file every 5s and shuts down when it appears.
6. **Socket perms.** `/tmp/claude-wa.sock` is mode `0700`; state dir is `0700`.
7. **No content on disk.** The inbox log used by the Monitor workaround is meta-only. Message bodies stay in the daemon's in-memory cache.

## Connection stability

Preserved from upstream (OpenClaw-derived patterns, tuned for 24/7 operation):

| Pattern                    | Behavior                                                            |
|----------------------------|---------------------------------------------------------------------|
| 515 is normal              | WhatsApp restart request → reconnect in 2s                          |
| Never `process.exit`       | Only 440 (conflict) or 401 (logout) halt permanently                |
| Exponential backoff        | factor 1.8, jitter ±25%, max 30s, reset after 60s of healthy uptime |
| Watchdog                   | no inbound for 30 min → force reconnect                             |
| Creds backup               | auto-backup before each save, auto-restore if corrupt               |
| Singleton lock             | PID file prevents double-daemon                                     |
| Crypto-error recovery      | Baileys `bad mac` / auth errors → reconnect, not crash              |

## Troubleshooting

| Issue                                           | Fix                                                                        |
|-------------------------------------------------|----------------------------------------------------------------------------|
| `--channels entries must be tagged`             | Use `--channels server:whatsapp` (not bare `whatsapp`). See setup step 5.  |
| `server: entries need --dangerously-load-development-channels` | Add that flag alongside `--channels`. See setup step 5.     |
| `server:whatsapp` listed twice on startup       | zsh recursively expanded an alias — add `command` prefix in the alias.     |
| Session doesn't wake on `!all`                  | `/connect-wa` wasn't run in that session, so no Monitor is attached.       |
| `daemon request timeout`                        | Daemon not running. `npm run daemon` or `launchctl start …`.               |
| `WhatsApp not connected`                        | Pair again: `npm run pair`.                                                |
| Inbound reacts ❓                               | No route matched. Use `<N>`, `#<tag>`, `!all`, quote-reply, `/connect-wa`. |
| 440 in daemon.log                               | A 5th device replaced the daemon. Unlink something, re-pair.               |
| Messages stop silently                          | Watchdog catches in 30 min, or `launchctl stop && start`.                  |

## Limitations

- WhatsApp has no search API. `fetch_messages` only returns what the daemon has seen since startup.
- Message content never leaves the daemon's in-memory cache — the inbox log is meta-only by design. If a session needs the body after being woken by a Monitor event, it calls `fetch_messages`.
- `CLAUDE_SESSION_ID` env var isn't guaranteed to reach the MCP subprocess — the session client falls back to a generated UUID (number- and tag-based routing still work).
- Baileys is an unofficial client. Use on a secondary WhatsApp account, not your primary line.

## Credits

- [`diogo85/claude-code-whatsapp`](https://github.com/diogo85/claude-code-whatsapp) — upstream plugin, production-tuned single-session
- [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp Web Multi-Device library
- [OpenClaw](https://github.com/openclaw/openclaw) — connection stability reference

## License

MIT

# Multi-Session WhatsApp Channel for Claude Code

One WhatsApp line, many Claude Code terminals. Route replies to the right project by `[tag]` prefix, `#tag` address, `!all` broadcast, or quote-reply — all through a single WhatsApp linked-device slot.

A fork of [`diogo85/claude-code-whatsapp`](https://github.com/diogo85/claude-code-whatsapp), split into a persistent daemon plus a thin per-session MCP client.

> **Why a fork?** WhatsApp caps linked devices at 4. Running upstream's single-session plugin in more than a couple of Claude terminals at once knocks older sessions offline. This fork keeps one Baileys connection in a daemon and fans messages out to N Claude sessions over a local Unix socket.

## How it works

```
Phone (WhatsApp)
    ↕  WhatsApp Web Multi-Device (Baileys v7)
wa-daemon.cjs          ← persistent, single connection, managed by launchd
    ↕  /tmp/claude-wa.sock (JSON-line IPC)
session-client.cjs     ← thin MCP stdio subprocess, one per Claude session
    ↕  notifications/claude/channel
Claude Code            ← e.g. in ~/Work/polybillionaire or ~/Work/lodzik-cv
```

## Routing model

**Outbound (Claude → phone).** Every reply is auto-prefixed with `[${basename(cwd)}]` so the phone can tell sessions apart: `[polybillionaire] bot stopped out SOL`. Pass `prefix: false` to the `reply` tool to skip the tag.

**Inbound (phone → Claude).** The daemon classifies each incoming message in this order:

| Prefix                              | Routes to                                      |
|-------------------------------------|------------------------------------------------|
| `#<tag> <message>`                  | session(s) whose tag matches (prefix, case-insensitive) |
| `!all <message>`                    | every registered session                       |
| *(quote-reply to tagged outbound)*  | session that sent the quoted message           |
| *(none of the above)*               | the **active** session (most recent `/connect-wa`) |

If nothing matches, the daemon reacts with ❓ on the phone and drops.

## Setup

### 1. Install

```bash
git clone <this fork's URL> ~/Work/claude-whatsapp-mcp
cd ~/Work/claude-whatsapp-mcp
npm install
```

Node 20+ required. Bun is not supported (Baileys depends on Node WebSocket events Bun doesn't emit).

### 2. Pair your WhatsApp account once

```bash
mkdir -p ~/.claude/channels/whatsapp/auth
WHATSAPP_STATE_DIR=~/.claude/channels/whatsapp npm run pair
# Scan the QR on your phone at WhatsApp > Linked Devices > Link a Device
# (Alternative: PAIR_PHONE=<E.164 number> for pairing-code flow)
```

Wait for `✅ WhatsApp connected!`. Auth creds land in `~/.claude/channels/whatsapp/auth/`.

### 3. Start the daemon

Two options.

**Option A — launchd (recommended for 24/7):**

```bash
# Copy the template and edit absolute paths inside
cp code.claude.whatsapp-daemon.plist ~/Library/LaunchAgents/
# Edit ~/Library/LaunchAgents/code.claude.whatsapp-daemon.plist
#   - ProgramArguments[1] → absolute path to wa-daemon.cjs
#   - WorkingDirectory → this repo's absolute path
#   - WHATSAPP_STATE_DIR + log paths → absolute path to ~/.claude/channels/whatsapp
launchctl load ~/Library/LaunchAgents/code.claude.whatsapp-daemon.plist
```

**Option B — foreground for testing:**

```bash
WHATSAPP_STATE_DIR=~/.claude/channels/whatsapp npm run daemon
```

Daemon logs land at `~/.claude/channels/whatsapp/daemon.log`. The session client will also auto-spawn the daemon (detached) if it finds `/tmp/claude-wa.sock` missing — set `WA_AUTO_SPAWN=0` to disable.

### 4. Configure `.mcp.json` in each project

Already handled if you install this as a Claude Code plugin. For a manual config:

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

### 5. Claim a session

In any Claude Code terminal where you want untagged phone replies to land:

```
/connect-wa
```

You can also just use `#<basename>` from the phone to address a session that isn't active, or quote-reply one of its outbound messages.

## Skills

Three user-invocable slash commands are installed to `~/.claude/skills/`:

| Command            | Purpose                                                                 |
|--------------------|-------------------------------------------------------------------------|
| `/connect-wa`      | Claim this terminal as the active WhatsApp listener                     |
| `/disconnect-wa`   | Release the active-session claim; another registered session takes over |
| `/wa-status`       | List every registered session and whether WhatsApp is connected         |

## MCP tools

| Tool                       | Description                                                       |
|----------------------------|-------------------------------------------------------------------|
| `reply`                    | Send text + file attachments (auto-prefixed with `[tag]`)         |
| `react`                    | Emoji reaction on a message                                       |
| `download_attachment`      | Download media to `~/.claude/channels/whatsapp/inbox/`            |
| `fetch_messages`           | Recent messages for a chat (daemon cache)                         |
| `claim_active_session`     | Make this session the active untagged-reply target                |
| `release_active_session`   | Release the active claim                                          |
| `list_sessions`            | Every registered session + which one is active                    |

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
- `confirmToken: "some-secret"` — optional. If set, inbound messages that start with the token get `meta.origin_confirmed="true"`; others get `"false"`. Claude sees this and treats destructive operations (Write/Edit/Bash) as pending approval unless confirmed. You still get a permission request on the phone for those — the token is an *addition*, not a replacement.

Permission requests from Claude arrive on WhatsApp as:

```
🔐 [polybillionaire] Permission request [tbxkq]

Bash: rm -rf /tmp/foo

Reply "yes tbxkq" or "no tbxkq"
```

Reply from phone; Claude proceeds or stops. The plugin reacts ✅/❌ to confirm receipt.

## Security

This plugin lets anyone on your WhatsApp allowlist send prompts to Claude Code sessions with access to your codebase. Attack surface in the multi-session setup:

1. **Use `allowFrom`.** Empty = open relay. Don't.
2. **Secondary number recommended.** Use a Google Voice / second SIM for the bot account. Running on your primary number increases ban risk with any unofficial WhatsApp client.
3. **Destructive tools need confirmation.** Configure Claude Code's `allowedTools` to exclude `Write`, `Edit`, `Bash(destructive)` by default — those trigger permission relay to the phone. Set `confirmToken` for an extra password-gate hint.
4. **Origin tagging.** Every WhatsApp-sourced channel message has `meta.origin="whatsapp"` so Claude can distinguish it from terminal input.
5. **Kill switch.** `touch ~/.claude/channels/whatsapp/PANIC` — daemon polls this file every 5s and shuts down when it appears.
6. **Socket perms.** `/tmp/claude-wa.sock` is mode `0700`; state dir is `0700`.

## Connection stability

Preserved from upstream (OpenClaw-derived patterns, lived for 24/7 operation):

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

| Issue                                          | Fix                                                                   |
|------------------------------------------------|-----------------------------------------------------------------------|
| `daemon request timeout`                       | Daemon not running. `npm run daemon` or `launchctl start …`           |
| `WhatsApp not connected`                       | Pair again: `npm run pair`                                            |
| Inbound reacts ❓                              | No route matched. Use `#<tag>`, `!all`, quote-reply, or `/connect-wa` |
| 440 in daemon.log                              | A 5th device replaced the daemon. Unlink something, re-pair           |
| Messages stop silently                         | Watchdog catches in 30 min, or `launchctl stop && start`              |
| Two daemons running                            | PID lock should prevent; if not, `launchctl unload` then re-load      |

## Limitations

- WhatsApp has no search API. `fetch_messages` only returns what the daemon has seen since startup.
- `CLAUDE_SESSION_ID` env var isn't guaranteed to reach the MCP subprocess — session client falls back to a generated UUID when it's missing (tag-based routing still works).
- Baileys is an unofficial client. Use on a secondary WhatsApp account, not your primary line.

## Credits

- [`diogo85/claude-code-whatsapp`](https://github.com/diogo85/claude-code-whatsapp) — upstream plugin, production-tuned single-session
- [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp Web Multi-Device library
- [OpenClaw](https://github.com/openclaw/openclaw) — connection stability reference

## License

MIT

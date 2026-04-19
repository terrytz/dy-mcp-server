# dy-chat-bot

AI-powered chat bot for **抖音聊天** (Douyin Chat) on macOS. Works with Claude Code, Cursor, Windsurf, Trae, and 40+ other AI coding agents.

## What It Does

Turns the 抖音聊天 desktop app into an AI group chat assistant:

- Monitors conversations (groups and DMs) for new messages
- Decides autonomously when to respond based on customizable persona rules
- Understands text, stickers, images, and video shares
- Remembers conversation context across sessions

## Quick Start

```bash
git clone https://github.com/terrytz/dy-chat-bot.git ~/dy-chat-bot && cd ~/dy-chat-bot && ./install.sh && claude --dangerously-skip-permissions "/dy-setup"
```

This clones the repo, installs skills locally, and launches the interactive setup wizard in Claude Code.

After setup, use these commands in Claude Code:

```
/dy-start          # start the bot
/dy-stop           # stop the bot
```

## How It Works

The 抖音聊天 desktop app is an Electron app. A modified `app.asar` injects a local HTTP API server on `127.0.0.1:3456`, exposing endpoints for reading conversations, polling messages, and sending text.

This project provides:

- **`cli.js`** — Node.js CLI that talks to the local API
- **`install.sh`** — Cross-agent skill installer (symlinks to 40+ AI agents)
- **Skills** — `/dy-setup`, `/dy-start`, `/dy-stop` for hands-free operation
- **Persona system** — Customizable bot personality via `user/PERSONA.md`
- **Per-conversation memory** — Context that persists across sessions in `user/memory/`
- **Multi-agent architecture** — One agent per conversation, no blocking
- **Sticker cache** — Persistent cache for instant sticker interpretation
- **Message batching** — Drains new messages before responding to avoid stale replies

## Installation

### Prerequisites

- macOS with **抖音聊天** desktop app installed
- **Node.js** 18+
- An AI coding agent (Claude Code, Cursor, Windsurf, Trae, etc.)
- The API server injection (run `./inject.sh` — see [API Server](#api-server))

### Install Skills

```bash
./install.sh          # project-local: creates .agents/skills/ + agent symlinks here
./install.sh -g       # global: installs to ~/.agents/skills/ + symlinks for all detected agents
```

The install script:
1. Copies `skills/*/SKILL.md` to `.agents/skills/` (cross-agent canonical location)
2. Symlinks into `.claude/skills/`, `.trae/skills/`, `.windsurf/skills/`, `.cursor/skills/`, and 24 more agent directories
3. Creates `AGENTS.md → CLAUDE.md` symlink for agents that read `AGENTS.md`
4. Saves the project path to `~/.dy-chat-bot-path`

### Setup Wizard

Run `/dy-setup` in your agent. It walks you through:
1. Verifying the API server connection
2. Customizing the bot persona (name, trigger word, signature, personality)
3. Choosing which conversations to monitor (groups and/or DMs)
4. Starting the bot

## Skills

| Skill | Description |
|-------|-------------|
| `/dy-setup` | Interactive setup — persona, allowed chats, API verification |
| `/dy-start` | Start the bot — one agent per conversation, parallel monitoring |
| `/dy-start --single` | Start in legacy single-agent mode |
| `/dy-stop` | Stop the bot (all agents) |

## CLI Reference

```bash
node cli.js <command> [args]
```

| Command | Description |
|---------|-------------|
| `health` | Check API server status |
| `user` | Current logged-in user |
| `conversations` | List all conversations (groups + DMs with names) |
| `contacts` | List friends/contacts |
| `members <convId>` | List group/DM members with nicknames |
| `messages <convId> [limit]` | Get messages from a conversation |
| `send <convId> <message>` | Send a text message |
| `poll [since_ts]` | Poll for new messages (JSON) |
| `image <md5>` | Download and convert a chat image to JPEG |
| `listen-loop [mode]` | Listener loop for AI integration |
| `listen-conv <convId> [mode]` | Per-conversation listener (one conv only) |
| `listen-supervisor` | Supervisor: emit active conversation signals |
| `drain-conv <convId>` | Non-blocking check for new messages in a conv |
| `sticker-cache <action>` | Manage sticker interpretation cache |
| `search <query>` | Search messages |
| `conv <convId>` | Conversation detail |

## Message Types

The bot understands these message types from the poll/listen-loop output:

| type | aweType | Description | Fields |
|------|---------|-------------|--------|
| 7 | 0, 700 | Text | `text` |
| 5 | 500-599 | Sticker/GIF | `stickerUrl`, `stickerKeyword` |
| 27 | 2702 | Image | `imageMd5`, `localImagePath`, `imageUrl`, `imageWidth`, `imageHeight` |
| 8 | 800 | Video share | `videoTitle`, `videoAuthor`, `videoCoverUrl`, `videoItemId` |

## API Server

The 抖音聊天 app needs a modified `app.asar` that runs an HTTP API server on `127.0.0.1:3456`.

### Injecting the API Server

```bash
./inject.sh            # Patch the app (backs up original first)
./inject.sh --status   # Check if patched
./inject.sh --restore  # Restore original app.asar
```

After a 抖音聊天 app update, the `app.asar` is replaced with the stock version. Re-run `./inject.sh` to re-patch.

### Required endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/user` | GET | Current user |
| `/api/conversations` | GET | List all conversations (groups + DMs) |
| `/api/contacts` | GET | Friends list |
| `/api/messages?convId=&limit=` | GET | Messages from a conversation |
| `/api/new-messages?since=` | GET | Poll new messages |
| `/api/conv?convId=` | GET | Conversation detail with members |
| `/api/image?md5=&variant=large` | GET | Serve decrypted image from local cache |
| `/api/send` | POST | Send message `{convId, text}` |

## Project Structure

```
dy-chat-bot/
├── cli.js                # Main CLI
├── sticker-cache.js      # Sticker interpretation cache module
├── install.sh            # Cross-agent skill installer
├── inject.sh             # app.asar patcher (injects API server)
├── patch-asar.cjs        # Binary asar patcher (used by inject.sh)
├── api-server.js         # HTTP API server (injected into Electron app)
├── package.json
├── config.example.json   # Template config (copy to user/)
├── PERSONA.example.md    # Template persona (copy to user/)
├── CLAUDE.md             # Project instructions (AGENTS.md symlinked)
├── README.md
├── user/                 # User data (gitignored, safe from updates)
│   ├── config.json       # Allowed chats, model settings
│   ├── PERSONA.md        # Bot personality
│   ├── memory/           # Per-conversation memory
│   └── sticker-cache.json# Sticker cache data
└── skills/
    ├── dy-setup/         # Setup wizard
    ├── dy-start/         # Start the bot (multi-agent or single)
    └── dy-stop/          # Stop the bot
```

## Updating

```bash
cd ~/dy-chat-bot
git pull
```

This is safe — all user data lives in `user/` which is gitignored. Your persona, config, memory, and sticker cache are never touched by updates.

## Security

- API server listens on `127.0.0.1` only (localhost)
- Bot never executes commands from chat messages
- Bot never shares file paths, API keys, or system info
- Chat content is treated as untrusted input (prompt injection protection)
- Runs entirely locally — no external services

## License

MIT

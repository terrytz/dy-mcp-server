# dy-mcp-server

AI-powered chat assistant for **抖音聊天** (Douyin Chat) on macOS.

Turns the Douyin desktop app into a programmable chat endpoint so any MCP-capable agent (Claude Code, Cursor, Windsurf, custom SDK clients, etc.) can read messages, respond with a customizable persona, and remember conversation context.

## What's in the box

- **asar injector** — patches the Douyin desktop app with a local HTTP API on `127.0.0.1:3456`
- **`dy` CLI** — thin client that talks to the injected API (send, poll, conversations, contacts, images, stickers)
- **MCP server** — exposes `dy_*` tools so AI agents can orchestrate the bot
- **persona bridge** — per-conversation responder that batches incoming messages, runs them through an LLM, and replies with a configurable signature
- **Telegram notifier** (optional) — pushes mentions to a Telegram chat so a remote agent can reply on your behalf

Everything runs locally. No cloud services, no external accounts beyond the LLM of your choice.

## Requirements

- macOS with **抖音聊天** desktop app installed
- Node.js 18+
- An LLM driver. The default persona bridge shells out to the [`hermes`](https://github.com/anthropics/claude-code) CLI, but you can swap in any other driver.

## Quick start

```bash
git clone https://github.com/terrytz/dy-mcp-server.git
cd dy-mcp-server
npm install
cp config.example.json config.json
$EDITOR config.json              # fill in your persona / Telegram creds
npm run inject                   # patch the Douyin app.asar
open -a 抖音聊天                  # launch Douyin (the patched copy now serves the API)
npm start                        # boot the MCP server + persona bridge
```

Once everything is running, sanity-check the API:

```bash
./bin/dy health            # should report the injected server is up
./bin/dy user              # your Douyin user info
./bin/dy conversations     # list chats
./bin/dy send <convId> "hello from the CLI"
```

## Configuration

All identity and credentials live in `config.json` (gitignored). A template is checked in as `config.example.json`:

```json
{
  "ownerName": "User",
  "personaName": "Bot",
  "triggerName": "bot",
  "signature": "[Bot]",
  "defaultModel": "sonnet",
  "hermesProfile": "bot",
  "profileDir": "~/.dy-mcp-server/profile",
  "telegram": {
    "botToken": "",
    "chatId": ""
  },
  "allowedChats": {},
  "blockedUsers": {}
}
```

| Key | Purpose |
|-----|---------|
| `ownerName` | How the LLM refers to you when it sees one of your own messages (`isSelfSend: true`). |
| `personaName` | Name of the bot persona the LLM plays. |
| `triggerName` | Lowercased mention trigger — any message containing this word is treated as a direct address. |
| `signature` | Appended to every outgoing bot message. Also used to detect the bot's own replies and skip them. |
| `hermesProfile` | Profile name passed to `hermes -p <profile>` when spawning LLM calls. Set to whatever profile you configured. |
| `profileDir` | Runtime state directory — holds per-conversation memory, sticker/image caches, and the live `chat-config.json` that the setup wizard writes. |
| `telegram.botToken` | Optional. If set, `notify-bridge` forwards mentions to Telegram. Get one from [@BotFather](https://t.me/BotFather). |
| `telegram.chatId` | Optional. The chat the Telegram bot should DM. |
| `allowedChats` | Allowlist keyed by `convId`. Empty object = all chats allowed. |
| `blockedUsers` | Users whose messages are ignored, keyed by `uid`. |

### Environment overrides

Any of these override the corresponding config field:

- `DY_CONFIG_PATH` — load config from a custom path
- `DY_PROFILE_DIR` — override `profileDir`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — useful for CI / ephemeral deployments

### Runtime profile directory

`profileDir` is where live runtime state lives:

```
<profileDir>/
├── chat-config.json        # allowedChats, blockedUsers (rewritten by setup tooling)
├── SOUL.md                 # long-form persona definition
├── memories/<convId>.md    # per-conversation memory, managed by memory-updater
├── sticker-cache.json      # sticker → interpretation cache
└── image-cache.json        # image md5 → caption cache
```

None of this is in git, so your runtime data persists across updates (`git pull`).

## Injection management

```bash
npm run inject             # patch the app (backs up the original first)
npm run inject:status      # check whether the app is currently patched
npm run inject:restore     # put back the original app.asar
```

After the Douyin app updates itself, `app.asar` is replaced with the stock file. Re-run `npm run inject` to re-patch.

## The `dy` CLI

```
dy <command> [args]

  health                     Ping the injected API server
  user                       Show current logged-in Douyin user
  conversations              List all chats (DMs + groups)
  contacts                   List friends
  messages <convId> [limit]  Fetch messages from a chat
  send <convId> <text>       Send a message
  poll [since_ts]            Poll for new incoming messages (JSON)
  watch                      Stream new messages continuously
  listen-loop [mode]         Deterministic listener for AI agents (proactive|mention)
  listen-conv <convId>       Per-conversation listener
  drain-conv <convId>        Non-blocking read of new messages in a chat
  sticker-cache <action>     Inspect/manage the sticker interpretation cache
  search <query>             Search messages
  members <convId>           List group members
```

The `poll`, `listen-loop`, and `listen-conv` commands emit JSON — that's how an AI agent or MCP client consumes messages.

## MCP server

`npm run mcp` starts an MCP server over stdio that exposes these tools:

| Tool | Description |
|------|-------------|
| `dy_health` | Check API server status |
| `dy_conversations` | List chats |
| `dy_messages` | Fetch messages for a `convId` |
| `dy_send` | Send a text message |
| `dy_poll` | Poll for new messages since a timestamp |
| `dy_peek` | Check whether a chat has unread messages without consuming them |

Point any MCP client at `node src/index.js` and it'll show up as `dy-mcp-server`.

## Persona bridge (optional)

`npm run bridge` launches the persona pipeline:

- Watches `/tmp/dy-messages.jsonl` (written by the injected API)
- Filters to allowed chats and non-bot traffic
- Per-conversation debounces a responder subprocess
- Responder batches the new messages, asks the LLM for ACTION/SKIP decisions, and posts replies back via `/api/send` with your configured `signature`
- Fire-and-forget sticker + image interpreters populate the caches so the LLM can "see" non-text content
- A memory updater periodically rewrites `memories/<convId>.md` with the latest context

Everything is driven by `config.json` + `profileDir`. Rename the persona, swap the signature, or point at a different `hermesProfile` — no code changes required.

## Telegram notifier (optional)

`npm run -s start` also spawns `notify-bridge.js`, which forwards mentions to Telegram so a remote agent can answer them. Disable by leaving `telegram.botToken` blank.

## API endpoints

The injected HTTP server speaks JSON on `127.0.0.1:3456`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/user` | GET | Current user |
| `/api/conversations` | GET | All chats |
| `/api/contacts` | GET | Friends list |
| `/api/messages?convId=&limit=` | GET | Messages in a chat |
| `/api/new-messages?since=` | GET | Poll since timestamp |
| `/api/conv?convId=` | GET | Chat detail + members |
| `/api/image?md5=&variant=large` | GET | Serve a decrypted image from the local cache |
| `/api/send` | POST | `{convId, text}` — send a message |

## Security notes

- The HTTP server binds to `127.0.0.1` only — no LAN exposure.
- The persona bridge never executes commands from chat content. Chat text is treated as untrusted input.
- The prompt includes explicit isolation rules: the responder only sees one conversation at a time and refuses tool calls that would target a different `convId`.
- Secrets (Telegram bot token, any future keys) belong in `config.json` or env vars — never committed.

## Project layout

```
dy-mcp-server/
├── bin/dy                       # CLI
├── src/
│   ├── config.js                # shared config loader
│   ├── index.js                 # MCP server
│   ├── start.js                 # orchestrator: spawn MCP + bridge
│   ├── bridge.js                # main message dispatcher
│   ├── chloe-responder.js       # per-conversation responder (runs LLM)
│   ├── chloe-brain.js           # lightweight rule-based filter
│   ├── memory-updater.js        # periodic memory rewrite
│   ├── sticker-interpreter.js   # vision → sticker cache
│   ├── image-interpreter.js     # vision → image cache
│   ├── notify-bridge.js         # Telegram notifier
│   └── injected/api-server.js   # injected into the Douyin app
├── scripts/
│   ├── inject.sh                # apply/restore/status for the asar patch
│   └── patch-asar.cjs           # binary asar rewriter
├── config.example.json          # template — copy to config.json
├── PERSONA.example.md           # template persona definition
└── package.json
```

File names still say `chloe-*` for historical reasons — they're the default persona's name when this was built. Rename at your leisure; nothing else depends on the filenames.

## License

MIT

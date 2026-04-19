#!/usr/bin/env node
/**
 * notify-bridge.js — watches /tmp/dy-messages.jsonl for Chloe-relevant messages
 * and notifies Hermes via Telegram so Hermes can respond.
 *
 * Architecture:
 *   抖音聊天 app (injected API) → /tmp/dy-messages.jsonl
 *     → notify-bridge.js (fs.watch on jsonl log + Telegram bot API)
 *       → Telegram DM to Terry
 *         → Hermes receives notification
 *           → responds via dy_send (MCP → Douyin API)
 */

import { watch } from "node:fs";
import { openSync, readSync, closeSync, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = "http://127.0.0.1:3456";

// ─── Config ──────────────────────────────────────────────────────────────────

const DY_DIR = process.env.DY_DIR || (() => {
  try { return readFileSync("/Users/terry/.dy-chat-bot-path", "utf8").trim(); }
  catch { return "/Users/terry/code/dy-chat-bot"; }
})();

const LOG = "/tmp/dy-messages.jsonl";
const CURSOR = "/tmp/dy-bridge.cursor";
const POLL_TIMEOUT = 120_000; // 2 min fallback poll

// Telegram — set via env or read from Hermes config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "338918657";

// ─── Config loaders ─────────────────────────────────────────────────────────

function loadTriggerName() {
  try {
    const persona = readFileSync(join(DY_DIR, "user", "PERSONA.md"), "utf8");
    const match = persona.match(/Trigger[:\s]*.*?"(\w+)"/i)
      || persona.match(/Name[:\s]*\*?\*?(\w+)/i);
    return match ? match[1].toLowerCase() : "chloe";
  } catch { return "chloe"; }
}

function loadSignature() {
  try {
    const config = JSON.parse(readFileSync(join(DY_DIR, "user", "config.json"), "utf8"));
    return config.signature || "[🎈Chloe🧸]";
  } catch { return "[🎈Chloe🧸]"; }
}

function loadAllowedChats() {
  try {
    const config = JSON.parse(readFileSync(join(DY_DIR, "user", "config.json"), "utf8"));
    return Object.keys(config.allowedChats || {});
  } catch { return []; }
}

function isAllowedChat(convId, allowed) {
  return allowed.length === 0 || allowed.includes(convId);
}

// ─── Cursor ─────────────────────────────────────────────────────────────────

function readCursor() {
  try { return parseInt(readFileSync(CURSOR, "utf8").trim()) || 0; }
  catch { return 0; }
}

function writeCursor(pos) {
  writeFileSync(CURSOR, String(pos));
}

// ─── Read new messages from jsonl log ───────────────────────────────────────

function readNewMessages() {
  if (!existsSync(LOG)) return [];
  let cursor = readCursor();
  const size = statSync(LOG).size;
  if (size <= cursor) return [];
  if (size < cursor) cursor = 0; // file was truncated

  const buf = Buffer.alloc(size - cursor);
  const fd = openSync(LOG, "r");
  readSync(fd, buf, 0, buf.length, cursor);
  closeSync(fd);
  writeCursor(size);

  return buf.toString().trim().split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

// ─── Telegram notifier ─────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("[bridge] TELEGRAM_BOT_TOKEN not set, notification skipped");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) console.error("[bridge] Telegram error:", data.description);
  } catch (err) {
    console.error("[bridge] Telegram failed:", err.message);
  }
}

async function getConvName(convId) {
  try {
    const res = await fetch(`${BASE_URL}/api/conv?convId=${encodeURIComponent(convId)}`);
    const data = await res.json();
    return data.data?.conversation?.name
      || data.data?.conversation?.nickname
      || convId;
  } catch { return convId; }
}

// ─── Message processing ──────────────────────────────────────────────────────

async function processMessages(rawMsgs, { triggerName, signature, allowed }) {
  const triggerLower = triggerName.toLowerCase();

  // Filter: allowed chats, non-bot, meaningful content
  const relevant = rawMsgs.filter(m => {
    if (!isAllowedChat(m.convId, allowed)) return false;
    if (m.isBotMessage) return false;
    // Skip Chloe's own outgoing messages
    if (m.text && m.text.endsWith(signature)) return false;
    // Skip empty non-media messages
    if (!m.text && m.type !== 5 && m.type !== 27 && m.type !== 8) return false;
    return true;
  });

  // Group by conversation
  const byConv = new Map();
  for (const m of relevant) {
    if (!byConv.has(m.convId)) byConv.set(m.convId, []);
    byConv.get(m.convId).push(m);
  }

  for (const [convId, msgs] of byConv) {
    const hasMention = msgs.some(m =>
      m.text && m.text.toLowerCase().includes(triggerLower)
    );

    // Proactive (no mention): only care about stickers/images/video shares
    const hasMedia = msgs.some(m => m.type === 5 || m.type === 27 || m.type === 8);

    if (!hasMention && !hasMedia) continue;

    const convName = await getConvName(convId);

    const msgLines = msgs.map(m => {
      if (m.type === 5) return `[Sticker] ${m.stickerKeyword || ""}`.trim();
      if (m.type === 27 || m.aweType === 2702) return "[Image] 🖼️";
      if (m.type === 8 || m.aweType === 800) return `[Video] ${m.videoTitle || ""}`.trim();
      return m.text || "";
    }).filter(Boolean).join(" | ");

    const prefix = hasMention ? "📩 *" : "📩 [Proactive] ";
    const text = `${prefix}Chloe mentioned in ${convName}*\n\n${msgLines}\n\n---\nReply here to respond as Chloe.`;

    console.log(`[bridge] → Telegram notification: ${convName}, ${msgs.length} msg(s), mention=${hasMention}`);
    await sendTelegram(text);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const triggerName = loadTriggerName();
  const signature = loadSignature();
  const allowed = loadAllowedChats();

  console.log(`[bridge] trigger="${triggerName}", signature="${signature}"`);
  console.log(`[bridge] allowed=${allowed.length === 0 ? "all" : allowed.join(", ")}`);
  console.log(`[bridge] log=${LOG}`);

  // Init cursor to current end of log
  if (existsSync(LOG)) {
    writeCursor(statSync(LOG).size);
  }

  let running = true;
  let pollTimer = null;

  function armPoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (!running) return;
      const msgs = readNewMessages();
      if (msgs.length) await processMessages(msgs, { triggerName, signature, allowed });
      if (running) armPoll();
    }, POLL_TIMEOUT);
  }

  async function tick() {
    const msgs = readNewMessages();
    if (msgs.length) await processMessages(msgs, { triggerName, signature, allowed });
  }

  // Watch-based loop with polling fallback
  let watcher = null;
  let watcherActive = false;

  try {
    watcher = watch(LOG, { persistent: false }, async (eventType) => {
      if (!running) return;
      if (eventType !== "change") return;
      try {
        await tick();
      } catch (err) {
        console.error("[bridge] tick error:", err.message);
      }
    });
    watcher.on("error", (err) => {
      console.warn("[bridge] fs.watch error, polling fallback:", err.message);
      watcherActive = false;
      try { watcher.close(); } catch {}
      armPoll();
    });
    watcher.on("ready", () => {
      watcherActive = true;
      console.log("[bridge] fs.watch active");
      // Also arm poll as fallback every 2min
      armPoll();
    });
  } catch (err) {
    console.warn("[bridge] fs.watch unavailable, polling only:", err.message);
    armPoll();
  }

  // Also watch stop file
  try {
    watch("/tmp", { persistent: false }, (eventType, filename) => {
      if (filename === "dy-bridge-stop") {
        console.log("[bridge] stop file detected");
        running = false;
        clearTimeout(pollTimer);
        try { watcher?.close(); } catch {}
        process.exit(0);
      }
    });
  } catch {}

  process.on("SIGINT", () => { running = false; clearTimeout(pollTimer); process.exit(0); });
  process.on("SIGTERM", () => { running = false; clearTimeout(pollTimer); process.exit(0); });

  console.log("[bridge] Ready");
}

main().catch(err => {
  console.error("[bridge] Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * chloe-brain.js — lightweight decision engine for Chloe
 *
 * Reads new messages from /tmp/dy-messages.jsonl, decides which ones
 * need Chloe to respond, and writes those to /tmp/dy-chloe-queue.jsonl.
 *
 * Zero LLM cost — pure rules. Runs in milliseconds.
 *
 * Usage: node chloe-brain.js
 *   (reads cursor from /tmp/dy-brain.cursor, writes decisions to /tmp/dy-chloe-queue.jsonl)
 */

import { openSync, readSync, closeSync, existsSync, statSync, writeFileSync, readFileSync, mkdirSync, rmdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";

const QUEUE_LOCK = "/tmp/dy-chloe-queue.lock";

async function acquireQueueLock({ maxWaitMs = 3000, pollMs = 30 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try { mkdirSync(QUEUE_LOCK); return true; }
    catch { await sleep(pollMs); }
  }
  return false;
}
function releaseQueueLock() { try { rmdirSync(QUEUE_LOCK); } catch {} }

const LOG = "/tmp/dy-messages.jsonl";
const CURSOR = "/tmp/dy-brain.cursor";
const QUEUE = "/tmp/dy-chloe-queue.jsonl";
const SEEN_CACHE = "/tmp/dy-brain-seen.json";
const SEEN_WINDOW = 500; // keep last 500 signatures

// ─── Runtime config ─────────────────────────────────────────────────────────
// Identity (owner, persona, signature) comes from ./config.js. Live chat
// state (allowedChats, blockedUsers) is written by the setup wizard into
// <profileDir>/chat-config.json and read fresh on every tick.

const PROFILE_DIR = loadConfig().profileDir;
const PROFILE_CONFIG = join(PROFILE_DIR, "chat-config.json");
const PROFILE_SOUL = join(PROFILE_DIR, "SOUL.md");

function loadChatConfig() {
  try { return JSON.parse(readFileSync(PROFILE_CONFIG, "utf8")); }
  catch { return {}; }
}

function loadTriggerName() {
  const cfg = loadChatConfig();
  if (cfg.triggerName) return String(cfg.triggerName).toLowerCase();
  try {
    const persona = readFileSync(PROFILE_SOUL, "utf8");
    const match = persona.match(/Trigger[:\s]*.*?"?(\w+)"?/i)
      || persona.match(/Name[:\s]*\*?\*?(\w+)/i);
    if (match) return match[1].toLowerCase();
  } catch {}
  return loadConfig().triggerName;
}

function loadSignature() {
  return loadChatConfig().signature || loadConfig().signature;
}

function loadAllowedChats() {
  const cfg = loadChatConfig();
  const allowed = cfg.allowedChats ?? loadConfig().allowedChats ?? {};
  return Object.keys(allowed);
}

function loadBlockedUsers() {
  const cfg = loadChatConfig();
  const blocked = cfg.blockedUsers ?? loadConfig().blockedUsers ?? {};
  return new Set(Object.keys(blocked));
}

function isAllowedChat(convId, allowed) {
  return allowed.length === 0 || allowed.includes(convId);
}

// ─── Message type constants ───────────────────────────────────────────────────
// These are aweType values as written to /tmp/dy-messages.jsonl by api-server.js
const AWE_TEXT         = 7;
const AWE_STICKER      = 5;
const AWE_IMAGE        = 27;
const AWE_VIDEO_SHARE  = 8;
const AWE_SHARE        = 105;
const AWE_REPLY        = 77;

// ─── Core decision logic ─────────────────────────────────────────────────────

// The brain no longer decides *whether* Chloe replies — that's now the LLM's job.
// Its only role is filtering noise: non-allowed chats, Chloe's own replies,
// blocked users, empty/system rows. Everything else is observed and handed
// to the responder, which resumes a per-conv hermes session.

function shouldObserve(msg, { signature, allowed, blocked }) {
  const senderId = msg.sender || msg.userId || "";

  if (!isAllowedChat(msg.convId, allowed)) {
    return { observe: false, reason: "not_allowed_chat" };
  }
  if (senderId && blocked.has(senderId)) {
    return { observe: false, reason: "blocked_user" };
  }
  if (msg.text && msg.text.endsWith(signature)) {
    return { observe: false, reason: "chloe_own_reply" };
  }
  if (!msg.text && msg.type !== AWE_STICKER && msg.type !== AWE_IMAGE && msg.type !== AWE_VIDEO_SHARE) {
    return { observe: false, reason: "empty_non_media" };
  }
  return { observe: true, reason: "observe" };
}

// ─── Dedupe ─────────────────────────────────────────────────────────────────
// api-server occasionally writes the same message twice to /tmp/dy-messages.jsonl.
// Signature: convId|sender|createdAt|text|stickerUrl. LRU window of SEEN_WINDOW entries.

function msgSig(msg) {
  return [
    msg.convId || "",
    msg.sender || msg.userId || "",
    msg.createdAt || "",
    (msg.text || "").slice(0, 40),
    (msg.stickerUrl || "").split("?")[0],
  ].join("|");
}

function loadSeen() {
  try {
    const arr = JSON.parse(readFileSync(SEEN_CACHE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveSeen(list) {
  try { writeFileSync(SEEN_CACHE, JSON.stringify(list.slice(-SEEN_WINDOW))); }
  catch {}
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
  if (size < cursor) cursor = 0; // file was truncated / rotated

  const buf = Buffer.alloc(size - cursor);
  const fd = openSync(LOG, "r");
  readSync(fd, buf, 0, buf.length, cursor);
  closeSync(fd);
  writeCursor(size);

  return buf.toString("utf8").trim().split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

// ─── Queue ───────────────────────────────────────────────────────────────────

// Buffer enqueues in-memory; flush once at end of run under queue lock.
const pendingEnqueues = [];

function enqueue(decision, msg) {
  pendingEnqueues.push({
    ...msg,
    _chloe_reason: decision.reason,
    _chloe_proactive: decision.proactive || false,
    _queued_at: new Date().toISOString(),
  });
}

async function flushEnqueues() {
  if (pendingEnqueues.length === 0) return;
  const got = await acquireQueueLock();
  if (!got) console.warn("[brain] could not acquire queue lock, proceeding without");
  try {
    const chunk = pendingEnqueues.map(e => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(QUEUE, chunk);
  } finally {
    releaseQueueLock();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const signature = loadSignature();
  const allowed = loadAllowedChats();
  const blocked = loadBlockedUsers();

  const msgs = readNewMessages();
  if (msgs.length === 0) {
    process.exit(0); // nothing new
  }

  const seen = new Set(loadSeen());
  const seenList = [...seen];

  let observed = 0;
  let skipped = 0;
  let deduped = 0;
  const convsTouched = new Set();

  for (const msg of msgs) {
    const sig = msgSig(msg);
    if (seen.has(sig)) {
      deduped++;
      continue;
    }
    seen.add(sig);
    seenList.push(sig);

    const decision = shouldObserve(msg, { signature, allowed, blocked });
    if (decision.observe) {
      enqueue(decision, msg);
      observed++;
      convsTouched.add(msg.convId);
    } else {
      skipped++;
      if (skipped <= 3) {
        console.log(`[brain] ✗ skip (${decision.reason}): user=${(msg.sender || msg.userId)} conv=${msg.convId}`);
      }
    }
  }

  saveSeen(seenList);
  await flushEnqueues();
  const dedupStr = deduped > 0 ? `, ${deduped} deduped` : "";
  console.log(`[brain] observed ${observed} msg(s) across ${convsTouched.size} conv(s), ${skipped} filtered${dedupStr}`);
  if (convsTouched.size > 0) {
    console.log(`CONV_TOUCHED:${[...convsTouched].join(",")}`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error("[brain] Fatal:", err);
  process.exit(1);
});

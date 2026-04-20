#!/usr/bin/env node
/**
 * bridge.js — Chloe's ear.
 *
 * Watches /tmp/dy-messages.jsonl, filters in-process (no brain subprocess),
 * per-conversation-debounces chloe-responder.js, and fires the background
 * sticker-interpreter on uncached stickers.
 *
 * Flow:
 *   抖音聊天 → /tmp/dy-messages.jsonl (api-server.js appends)
 *     → bridge.js fs.watch
 *       → (in-process) filter + dedupe → /tmp/dy-chloe-queue.jsonl
 *       → per-conv debounce timer (DEBOUNCE_MS)
 *         → chloe-responder.js --conv <convId>
 *       → for each observed sticker: if not cached, spawn sticker-interpreter detached
 */

import {
  watch, existsSync, statSync, readFileSync, writeFileSync,
  openSync, readSync, closeSync, appendFileSync, mkdirSync, rmdirSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";

// ─── Paths ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOG = "/tmp/dy-messages.jsonl";
const BRIDGE_CURSOR = "/tmp/dy-bridge.cursor";
const QUEUE = "/tmp/dy-chloe-queue.jsonl";
const QUEUE_LOCK = "/tmp/dy-chloe-queue.lock";
const STOP_FILE = "/tmp/dy-bridge-stop";

const { profileDir: PROFILE_DIR } = loadConfig();
const CHAT_CONFIG = join(PROFILE_DIR, "chat-config.json");
const STICKER_CACHE = join(PROFILE_DIR, "sticker-cache.json");
const IMAGE_CACHE = join(PROFILE_DIR, "image-cache.json");

const RESPONDER_PATH = join(__dirname, "chloe-responder.js");
const STICKER_INTERPRETER_PATH = join(__dirname, "sticker-interpreter.js");
const IMAGE_INTERPRETER_PATH = join(__dirname, "image-interpreter.js");

// ─── Tuning ──────────────────────────────────────────────────────────────────
// Per-conversation debounce window. Higher = more messages batched into a
// single responder turn (better context, slower replies). Lower = faster
// reply but fragmented batches. 3s is too aggressive for natural typing
// cadence (typing "记录血压" then "125/77, 86" usually takes 5–10s).
// Override with env: DY_DEBOUNCE_MS, DY_DEBOUNCE_CEILING_MS.

const DEBOUNCE_MS = Number(process.env.DY_DEBOUNCE_MS) || 8000;
const DEBOUNCE_CEILING_MS = Number(process.env.DY_DEBOUNCE_CEILING_MS) || 20000;
const SEEN_WINDOW = 500;

// ─── Cursor ──────────────────────────────────────────────────────────────────

function readCursor() {
  try { return parseInt(readFileSync(BRIDGE_CURSOR, "utf8").trim()) || 0; }
  catch { return 0; }
}
function writeCursor(pos) { writeFileSync(BRIDGE_CURSOR, String(pos)); }

function readNewMessages() {
  if (!existsSync(LOG)) return [];
  let cursor = readCursor();
  const size = statSync(LOG).size;
  if (size <= cursor) return [];
  if (size < cursor) cursor = 0;
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

// ─── Chat config (re-loaded lazily on each event; tiny file) ────────────────

function loadChatConfig() {
  try { return JSON.parse(readFileSync(CHAT_CONFIG, "utf8")); }
  catch { return {}; }
}

// ─── Queue lock ──────────────────────────────────────────────────────────────

async function acquireQueueLock({ maxWaitMs = 3000, pollMs = 30 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try { mkdirSync(QUEUE_LOCK); return true; }
    catch { await sleep(pollMs); }
  }
  return false;
}
function releaseQueueLock() { try { rmdirSync(QUEUE_LOCK); } catch {} }

async function flushEnqueues(entries) {
  if (entries.length === 0) return;
  const got = await acquireQueueLock();
  if (!got) console.warn("[bridge] could not acquire queue lock, appending anyway");
  try {
    const chunk = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(QUEUE, chunk);
  } finally {
    releaseQueueLock();
  }
}

// ─── Dedupe LRU (in-memory; stays warm across events) ───────────────────────

const seenSet = new Set();
const seenOrder = [];

function msgSig(msg) {
  return [
    msg.convId || "",
    msg.sender || msg.userId || "",
    msg.createdAt || "",
    (msg.text || "").slice(0, 40),
    (msg.stickerUrl || "").split("?")[0],
  ].join("|");
}

function markSeen(sig) {
  if (seenSet.has(sig)) return false;
  seenSet.add(sig);
  seenOrder.push(sig);
  while (seenOrder.length > SEEN_WINDOW) {
    seenSet.delete(seenOrder.shift());
  }
  return true;
}

// ─── Filter (was shouldObserve in brain) ─────────────────────────────────────

const AWE_STICKER = 5;
const AWE_IMAGE = 27;
const AWE_VIDEO_SHARE = 8;

function shouldObserve(msg, { signature, allowed, blocked }) {
  const senderId = msg.sender || msg.userId || "";
  if (allowed.length > 0 && !allowed.includes(msg.convId)) {
    return { ok: false, reason: "not_allowed_chat" };
  }
  if (senderId && blocked.has(senderId)) {
    return { ok: false, reason: "blocked_user" };
  }
  if (msg.text && msg.text.endsWith(signature)) {
    return { ok: false, reason: "bot_own_reply" };
  }
  if (!msg.text && msg.type !== AWE_STICKER && msg.type !== AWE_IMAGE && msg.type !== AWE_VIDEO_SHARE) {
    return { ok: false, reason: "empty_non_media" };
  }
  return { ok: true };
}

// ─── Sticker auto-interpretation ─────────────────────────────────────────────

function loadStickerCache() {
  if (!existsSync(STICKER_CACHE)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(STICKER_CACHE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { entries: {} };
  } catch { return { entries: {} }; }
}

function stickerKey(url) {
  if (!url) return "";
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; }
  catch { return url.split("?")[0]; }
}

function isStickerCached(cache, url) {
  const entries = cache.entries || {};
  if (entries[url]) return true;
  const target = stickerKey(url);
  for (const k of Object.keys(entries)) {
    if (stickerKey(k) === target) return true;
  }
  return false;
}

// Track stickers we've already kicked off an interpreter for this bridge run,
// to avoid spawning dupes when the same sticker arrives multiple times before
// the interpreter finishes writing to the cache.
const interpretedInFlight = new Set();

function spawnStickerInterpreter(url, keyword) {
  const k = stickerKey(url);
  if (!k || interpretedInFlight.has(k)) return;
  interpretedInFlight.add(k);
  // Forget in-flight after 60s so a retry is possible if the interpreter crashed.
  setTimeout(() => interpretedInFlight.delete(k), 60_000).unref();

  const args = [STICKER_INTERPRETER_PATH, "--url", url];
  if (keyword) { args.push("--keyword", keyword); }
  const child = spawn("node", args, { stdio: ["ignore", "ignore", "ignore"], detached: true });
  child.unref();
  console.log(`[bridge] spawned sticker-interpreter for ${k.slice(-60)}`);
}

// ─── Image auto-interpretation ───────────────────────────────────────────────

function loadImageCache() {
  if (!existsSync(IMAGE_CACHE)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(IMAGE_CACHE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { entries: {} };
  } catch { return { entries: {} }; }
}

function isImageCached(cache, md5) {
  return Boolean(cache.entries && cache.entries[md5]);
}

const imageInterpretedInFlight = new Set();

function spawnImageInterpreter(md5, url, convId, skey) {
  if (!md5 || imageInterpretedInFlight.has(md5)) return;
  imageInterpretedInFlight.add(md5);
  setTimeout(() => imageInterpretedInFlight.delete(md5), 120_000).unref();

  const args = [IMAGE_INTERPRETER_PATH, "--md5", md5];
  if (url) { args.push("--url", url); }
  if (convId) { args.push("--conv", convId); }
  if (skey) { args.push("--skey", skey); }
  const child = spawn("node", args, { stdio: ["ignore", "ignore", "ignore"], detached: true });
  child.unref();
  console.log(`[bridge] spawned image-interpreter for md5=${md5}`);
}

// ─── Per-conversation debounce ───────────────────────────────────────────────

const convState = new Map();
const responderRunning = new Set();

function scheduleResponder(convId) {
  const now = Date.now();
  const state = convState.get(convId) || { firstTouchAt: now, touchCount: 0 };
  const isReset = !!state.timer;
  if (state.timer) clearTimeout(state.timer);
  state.firstTouchAt = state.firstTouchAt || now;
  state.touchCount = (state.touchCount || 0) + 1;
  const elapsed = now - state.firstTouchAt;
  const delay = elapsed >= DEBOUNCE_CEILING_MS ? 0 : DEBOUNCE_MS;
  state.timer = setTimeout(() => fireResponder(convId), delay);
  convState.set(convId, state);
  const tag = convId.slice(-8);
  if (isReset) {
    console.log(`[bridge:${tag}] debounce reset — ${state.touchCount} msg(s) buffered, fire in ${delay}ms`);
  } else {
    console.log(`[bridge:${tag}] debounce armed — fire in ${delay}ms`);
  }
}

function fireResponder(convId) {
  convState.delete(convId);
  if (responderRunning.has(convId)) {
    console.log(`[bridge] responder for ${convId} already running, re-queueing`);
    scheduleResponder(convId);
    return;
  }
  responderRunning.add(convId);
  console.log(`[bridge] spawning responder for conv ${convId}`);
  const child = spawn("node", [RESPONDER_PATH, "--conv", convId], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", d => stdout += d.toString());
  child.stderr.on("data", d => stderr += d.toString());
  child.on("close", code => {
    responderRunning.delete(convId);
    if (stdout.trim()) {
      for (const l of stdout.trim().split("\n")) console.log(`[bridge:${convId.slice(-8)}] ${l}`);
    }
    if (code !== 0 && stderr) console.error(`[bridge:${convId.slice(-8)}] err: ${stderr.trim()}`);
  });
  child.unref();
}

// ─── Core: process new messages ──────────────────────────────────────────────

async function processNewMessages() {
  const msgs = readNewMessages();
  if (msgs.length === 0) return;

  // Identity fields (signature) come from project config. Live runtime state
  // (allowedChats, blockedUsers) is written by the setup wizard into
  // chat-config.json, so prefer that when present and fall back to project
  // defaults. Reading fresh each tick so wizard edits take effect without
  // restart.
  const project = loadConfig();
  const chatCfg = loadChatConfig();
  const signature = chatCfg.signature || project.signature;
  const allowed = Object.keys(chatCfg.allowedChats || project.allowedChats || {});
  const blocked = new Set(Object.keys(chatCfg.blockedUsers || project.blockedUsers || {}));

  const stickerCache = loadStickerCache();
  const imageCache = loadImageCache();

  const toEnqueue = [];
  const convsTouched = new Set();
  let observed = 0;
  let skipped = 0;
  let deduped = 0;
  let stickerJobs = 0;
  let imageJobs = 0;

  for (const msg of msgs) {
    const sig = msgSig(msg);
    if (!markSeen(sig)) { deduped++; continue; }

    const decision = shouldObserve(msg, { signature, allowed, blocked });
    if (!decision.ok) { skipped++; continue; }

    // Fire-and-forget sticker interpreter on cache miss.
    if (msg.type === AWE_STICKER && msg.stickerUrl && !isStickerCached(stickerCache, msg.stickerUrl)) {
      spawnStickerInterpreter(msg.stickerUrl, msg.stickerKeyword);
      stickerJobs++;
    }

    // Fire-and-forget image interpreter on cache miss.
    if (msg.type === AWE_IMAGE && msg.imageMd5 && !isImageCached(imageCache, msg.imageMd5)) {
      spawnImageInterpreter(msg.imageMd5, msg.imageUrl, msg.convId, msg.imageSkey);
      imageJobs++;
    }

    toEnqueue.push({
      ...msg,
      _chloe_reason: "observe",
      _chloe_proactive: false,
      _queued_at: new Date().toISOString(),
    });
    observed++;
    convsTouched.add(msg.convId);
  }

  await flushEnqueues(toEnqueue);

  if (observed > 0 || skipped > 0 || deduped > 0) {
    const parts = [`${observed} observed across ${convsTouched.size} conv(s)`];
    if (skipped > 0) parts.push(`${skipped} filtered`);
    if (deduped > 0) parts.push(`${deduped} deduped`);
    if (stickerJobs > 0) parts.push(`${stickerJobs} sticker job(s)`);
    if (imageJobs > 0) parts.push(`${imageJobs} image job(s)`);
    console.log(`[bridge] ${parts.join(", ")}`);
  }

  for (const convId of convsTouched) scheduleResponder(convId);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("[bridge] Starting (brain-in-process) — build: stickers+images+isolation v2");
  console.log("[bridge] log:", LOG);
  console.log("[bridge] responder:", RESPONDER_PATH);
  console.log("[bridge] sticker-interpreter:", STICKER_INTERPRETER_PATH);
  console.log("[bridge] image-interpreter:", IMAGE_INTERPRETER_PATH);
  console.log(`[bridge] per-conv debounce: ${DEBOUNCE_MS}ms (ceiling ${DEBOUNCE_CEILING_MS}ms) — override via DY_DEBOUNCE_MS / DY_DEBOUNCE_CEILING_MS`);

  if (existsSync(LOG)) writeCursor(statSync(LOG).size);

  let running = true;

  watch("/tmp", { persistent: false }, (eventType, filename) => {
    if (filename === "dy-bridge-stop") {
      console.log("[bridge] stop file detected");
      running = false;
      process.exit(0);
    }
  });

  process.on("SIGINT", () => { running = false; process.exit(0); });
  process.on("SIGTERM", () => { running = false; process.exit(0); });

  setInterval(() => {}, 60_000); // keepalive

  try {
    const watcher = watch(LOG, { persistent: false }, async (eventType) => {
      if (!running) return;
      if (eventType !== "change") return;
      try { await processNewMessages(); }
      catch (err) { console.error("[bridge] error:", err.message); }
    });
    watcher.on("error", err => console.error("[bridge] fs.watch error:", err.message));
    watcher.on("ready", () => console.log("[bridge] fs.watch active"));
    setTimeout(() => console.log("[bridge] fs.watch ready (fallback timer)"), 2000);
  } catch (err) {
    console.error("[bridge] fs.watch unavailable:", err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("[bridge] Fatal:", err);
  process.exit(1);
});

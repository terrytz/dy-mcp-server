#!/usr/bin/env node
/**
 * memory-updater.js — background subagent that rewrites a conversation's
 * memory file with new context learned in the recent exchange.
 *
 * Spawned detached by chloe-responder.js:
 *   node memory-updater.js --conv <convId>
 *
 * What it does:
 *   1. Reads ~/.hermes/profiles/chloe/memories/<convId>.md (current memory)
 *   2. Reads the last ~30 messages from /tmp/dy-messages.jsonl for that conv
 *   3. Asks hermes (ephemeral session) to rewrite the memory preserving
 *      structure, folding in new facts, compressing older sections if they've
 *      grown too long
 *   4. Atomically writes the result back
 *
 * This is fire-and-forget: the responder does NOT wait for it. If it fails,
 * memory simply doesn't get updated this round — the next trigger will retry.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, rmdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";

const PROFILE_DIR = loadConfig().profileDir;
const MEMORY_DIR = join(PROFILE_DIR, "memories");
const STICKER_CACHE = join(PROFILE_DIR, "sticker-cache.json");
const IMAGE_CACHE = join(PROFILE_DIR, "image-cache.json");
const CHAT_CONFIG = join(PROFILE_DIR, "chat-config.json");
const MSG_LOG = "/tmp/dy-messages.jsonl";

const CONTEXT_MSGS = 30;

function parseArgs() {
  const args = process.argv.slice(2);
  let convId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--conv" && args[i + 1]) { convId = args[i + 1]; i++; }
  }
  return { convId };
}

function loadSignature() {
  try {
    const sig = JSON.parse(readFileSync(CHAT_CONFIG, "utf8")).signature;
    if (sig) return sig;
  } catch {}
  return loadConfig().signature;
}
function loadConvName(convId) {
  try {
    const cfg = JSON.parse(readFileSync(CHAT_CONFIG, "utf8"));
    return cfg.allowedChats?.[convId]?.name || convId;
  } catch { return convId; }
}
function loadStickerCache() {
  try { return JSON.parse(readFileSync(STICKER_CACHE, "utf8")); }
  catch { return { entries: {} }; }
}
function loadImageCache() {
  try { return JSON.parse(readFileSync(IMAGE_CACHE, "utf8")); }
  catch { return { entries: {} }; }
}
function lookupImage(cache, md5) {
  if (!md5) return null;
  const e = cache.entries && cache.entries[md5];
  return e ? (e.description || e) : null;
}
function stickerKey(url) {
  if (!url) return "";
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; }
  catch { return url.split("?")[0]; }
}
function lookupSticker(cache, msg) {
  const entries = cache.entries || {};
  if (msg.stickerUrl && entries[msg.stickerUrl]) return entries[msg.stickerUrl].interpretation || entries[msg.stickerUrl];
  if (msg.stickerUrl) {
    const t = stickerKey(msg.stickerUrl);
    for (const [k, v] of Object.entries(entries)) if (stickerKey(k) === t) return (v && v.interpretation) || v;
  }
  return null;
}

function loadMemory(convId) {
  const path = join(MEMORY_DIR, `${convId}.md`);
  if (!existsSync(path)) return "";
  try { return readFileSync(path, "utf8"); }
  catch { return ""; }
}

function writeMemory(convId, content) {
  const path = join(MEMORY_DIR, `${convId}.md`);
  const tmp = path + ".tmp";
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function loadRecentMessages(convId, signature) {
  if (!existsSync(MSG_LOG)) return [];
  let raw;
  try { raw = readFileSync(MSG_LOG, "utf8"); }
  catch { return []; }
  const lines = raw.split("\n").filter(Boolean);
  const all = [];
  for (const l of lines) {
    try {
      const m = JSON.parse(l);
      if (m && m.convId === convId) all.push(m);
    } catch {}
  }
  // Dedupe by (sender|createdAt|text|stickerUrl)
  const seen = new Set();
  const out = [];
  for (const m of all) {
    const k = `${m.sender}|${m.createdAt}|${(m.text || "").slice(0, 40)}|${(m.stickerUrl || "").split("?")[0]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out.slice(-CONTEXT_MSGS);
}

function formatMsg(m, stickerCache, imageCache, signature) {
  const cfg = loadConfig();
  const isBot = m.text && m.text.endsWith(signature);
  const who = isBot ? cfg.personaName : (m.isSelfSend ? cfg.ownerName : (m.sender || "?"));
  if (m.type === 5) {
    const interp = lookupSticker(stickerCache, m);
    return `${who}: [sticker${interp ? `: ${interp}` : ""}]`;
  }
  if (m.type === 27) {
    const desc = lookupImage(imageCache, m.imageMd5);
    return `${who}: [image${desc ? `: ${desc}` : ""}]`;
  }
  if (m.type === 8) return `${who}: [video: ${m.videoTitle || ""}]`.replace(/: \]$/, "]");
  return `${who}: ${m.text || ""}`.replace(/\s+$/, "");
}

function buildPrompt(convId, currentMemory, recent, stickerCache, imageCache, signature) {
  const convName = loadConvName(convId);
  const today = new Date().toISOString().slice(0, 10);
  const transcript = recent.map(m => formatMsg(m, stickerCache, imageCache, signature)).join("\n");

  // Close port of the dy-chat-bot prompt — short, trust the model.
  return `You are maintaining the memory file for the Douyin conversation **${convName}** (conv ${convId}). Today is ${today}.

## Current memory

${currentMemory || "(empty — initialize with a sensible structure)"}

## Recent conversation (oldest → newest)

${transcript || "(no messages)"}

## Task

Update the memory file:
- Append a short summary of any new notable exchanges to the Recent Context section.
- If the transcript contradicts an existing fact (location, age, preference, role, etc.), correct that line.
- If Recent Context exceeds ~100 lines, compress the oldest ~50 into a Key Topics summary at the top.
- Keep all 血压记录 entries and other historical logs intact.
- Bump \`Last updated:\` to ${today}.

Return the full updated memory file. No markdown fences, no commentary — just the file content starting with its \`# <title>\` heading.`;
}

async function runHermes(prompt) {
  return new Promise((resolve, reject) => {
    const args = ["-p", loadConfig().hermesProfile, "chat", "-Q", "--source", "dy-memupd", "-q", prompt];
    const child = spawn("hermes", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
      env: { ...process.env, DY_MCP_ALLOWED_CONVS: "__none__" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("close", code => {
      if (code !== 0) { reject(new Error(`hermes exited ${code}: ${stderr.slice(0, 400)}`)); return; }
      resolve(stdout);
    });
    child.on("error", reject);
  });
}

function stripSessionHeader(stdout) {
  // Hermes -Q prints `session_id: <id>` first; strip it and any surrounding whitespace.
  return stdout.replace(/^\s*session_id:\s*[A-Za-z0-9_]+\s*/m, "").trim();
}

function stripCodeFences(text) {
  // The model may still wrap in ```markdown despite being told not to.
  return text.replace(/^```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/, "").trim();
}

// Global memory-updater lock — prevents memory-updater invocations for
// different conversations from running concurrently (they'd all pile onto the
// same local LM Studio slot, starving the chat responder). Only one memupd
// runs at a time, system-wide.
const GLOBAL_LOCK = "/tmp/dy-memupd.lock";

// Per-conv lock so the same conv doesn't retry stacking.
function perConvLock(convId) {
  return `/tmp/dy-memupd-${convId.replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`;
}

function tryLock(path) {
  try { mkdirSync(path); return true; }
  catch { return false; }
}
function releaseLock(path) { try { rmdirSync(path); } catch {} }

// Stale-lock cleanup: if a lockdir is older than 10 minutes, assume a previous
// memupd died without releasing and reap it so new runs can proceed.
function reapStaleLock(path, maxAgeMs = 10 * 60_000) {
  try {
    const { mtimeMs } = require("node:fs").statSync(path);
    if (Date.now() - mtimeMs > maxAgeMs) {
      rmdirSync(path);
      return true;
    }
  } catch { /* not present */ }
  return false;
}

function conversationIdleSeconds(convId) {
  if (!existsSync(MSG_LOG)) return Infinity;
  let raw;
  try { raw = readFileSync(MSG_LOG, "utf8"); } catch { return Infinity; }
  let lastTs = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m && m.convId === convId && m.createdAt && m.createdAt > lastTs) {
        lastTs = m.createdAt;
      }
    } catch {}
  }
  if (!lastTs) return Infinity;
  return Math.max(0, (Date.now() - lastTs) / 1000);
}

async function main() {
  const { convId } = parseArgs();
  if (!convId) {
    console.error("[memupd] --conv required");
    process.exit(2);
  }

  // Bail out if the conversation is still actively receiving messages.
  // Running memupd during an active chat hogs the local model's single slot
  // and makes the main responder feel sluggish. Deferral is cheap — the next
  // responder fire will re-trigger this once the message counter crosses the
  // threshold again. Idle window overridable via DY_MEMUPD_IDLE_SEC (default 90s).
  const idleSec = conversationIdleSeconds(convId);
  const minIdle = Number(process.env.DY_MEMUPD_IDLE_SEC) || 90;
  if (idleSec < minIdle) {
    console.log(`[memupd] conv=${convId} only ${idleSec.toFixed(0)}s idle (< ${minIdle}s threshold), deferring`);
    process.exit(0);
  }

  // Acquire global lock so only one memory-updater runs at a time across all convs.
  reapStaleLock(GLOBAL_LOCK);
  const convLockPath = perConvLock(convId);
  reapStaleLock(convLockPath);

  if (!tryLock(convLockPath)) {
    console.log(`[memupd] another memupd is already running for ${convId}, exiting`);
    process.exit(0);
  }

  // Wait up to 30s for the global lock (another conv's memupd in flight).
  let gotGlobal = false;
  for (let i = 0; i < 60; i++) {
    if (tryLock(GLOBAL_LOCK)) { gotGlobal = true; break; }
    await sleep(500);
  }
  if (!gotGlobal) {
    console.log("[memupd] global lock contended for 30s, exiting");
    releaseLock(convLockPath);
    process.exit(0);
  }

  // Register a single release path for both locks so every exit path —
  // including uncaught errors — cleans up reliably.
  const releaseBoth = () => {
    releaseLock(GLOBAL_LOCK);
    releaseLock(convLockPath);
  };
  process.on("exit", releaseBoth);
  process.on("SIGINT", () => { releaseBoth(); process.exit(130); });
  process.on("SIGTERM", () => { releaseBoth(); process.exit(143); });

  // Re-check idleness after waiting — a new msg may have arrived.
  const idleAgain = conversationIdleSeconds(convId);
  if (idleAgain < minIdle) {
    console.log(`[memupd] conv became active during wait (${idleAgain.toFixed(0)}s idle), deferring`);
    process.exit(0);
  }

  const signature = loadSignature();
  const stickerCache = loadStickerCache();
  const imageCache = loadImageCache();
  const currentMemory = loadMemory(convId);
  const recent = loadRecentMessages(convId, signature);

  if (recent.length === 0) {
    console.log("[memupd] no messages to learn from, skipping");
    process.exit(0);
  }

  const prompt = buildPrompt(convId, currentMemory, recent, stickerCache, imageCache, signature);
  console.log(`[memupd] conv=${convId} memory=${currentMemory.length}b recent=${recent.length}msgs`);

  let raw;
  try { raw = await runHermes(prompt); }
  catch (err) {
    console.error("[memupd] hermes failed:", err.message);
    process.exit(1);
  }

  const cleaned = stripCodeFences(stripSessionHeader(raw));
  if (!cleaned || cleaned.length < 20) {
    console.error("[memupd] output too short, refusing to clobber memory");
    process.exit(1);
  }
  // Guard against wholesale compression: a legitimate update (additions +
  // line-level corrections) should leave the file the same size or larger.
  // Reject only if the model shrunk the file by more than 20% — gives room
  // for corrections that tighten a line while blocking "oops, I summarized
  // everything" mistakes. Keep a backup of the previous version so recovery
  // is easy if we ever accept a bad update.
  try {
    if (currentMemory) {
      writeFileSync(join(MEMORY_DIR, `${convId}.md.prev`), currentMemory);
    }
  } catch {}
  if (currentMemory.length > 200 && cleaned.length < currentMemory.length * 0.80) {
    console.error(`[memupd] output shrunk from ${currentMemory.length} to ${cleaned.length} bytes — refusing (looks like compression, not correction)`);
    try {
      writeFileSync("/tmp/dy-memupd-reject.log",
        `--- rejected output (${cleaned.length} bytes, was ${currentMemory.length}) ---\n${cleaned}\n`);
    } catch {}
    process.exit(1);
  }

  writeMemory(convId, cleaned);
  const delta = cleaned.length - currentMemory.length;
  const sign = delta >= 0 ? "+" : "";
  console.log(`[memupd] wrote ${cleaned.length} bytes (${sign}${delta}) to memories/${convId}.md`);
  process.exit(0);
}

main().catch(err => {
  console.error("[memupd] fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * sticker-interpreter.js — background vision subagent that interprets an
 * uncached Douyin sticker and writes the result to sticker-cache.json.
 *
 * Spawned detached by bridge.js:
 *   node sticker-interpreter.js --url <stickerUrl> [--keyword <keyword>]
 *
 * Flow:
 *   1. Normalize URL → check sticker-cache.json; if already present, exit.
 *   2. Acquire per-sticker lock so duplicate fires don't race.
 *   3. Try to get the image bytes — first via the Douyin in-app endpoint
 *      /api/image?md5=<hash> (already decrypted + local), fallback to
 *      fetching stickerUrl directly.
 *   4. Save to /tmp/chloe-sticker-<hash>.{jpg|png}
 *   5. Call `hermes -p chloe chat --image <path> -q "..."` to describe it.
 *   6. Clean the output and write to sticker-cache.json under both the
 *      original URL and the normalized key.
 *   7. Exit.
 *
 * Fire-and-forget: if anything goes wrong, we just don't populate the cache
 * for this sticker. Next time it appears, we try again.
 */

import {
  readFileSync, writeFileSync, existsSync, renameSync,
  mkdirSync, rmdirSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";

const PROFILE_DIR = join(process.env.HOME || "/Users/terry", ".hermes/profiles/chloe");
const STICKER_CACHE = join(PROFILE_DIR, "sticker-cache.json");
const CACHE_LOCK = "/tmp/dy-sticker-cache.lock";
const TMP_DIR = "/tmp";
const DY_BASE = "http://127.0.0.1:3456";

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let url = null;
  let keyword = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) { url = args[i + 1]; i++; }
    else if (args[i] === "--keyword" && args[i + 1]) { keyword = args[i + 1]; i++; }
  }
  return { url, keyword };
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

function stickerKey(url) {
  if (!url) return "";
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; }
  catch { return url.split("?")[0]; }
}

function shortHash(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

function tryExtractMd5(url) {
  // Douyin sticker paths look like:
  //   /obj/tos-cn-i-.../<md5>
  //   /obj/ies.fe.effect/<md5>
  // Where <md5> is a 32-char hex. Grab it so we can use /api/image?md5=.
  const m = url.match(/\/obj\/[^/]+\/([a-f0-9]{32})/i);
  return m ? m[1] : null;
}

// ─── Cache load/save (file-locked) ───────────────────────────────────────────

async function acquireCacheLock({ maxWaitMs = 5000, pollMs = 50 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try { mkdirSync(CACHE_LOCK); return true; }
    catch { await sleep(pollMs); }
  }
  return false;
}
function releaseCacheLock() { try { rmdirSync(CACHE_LOCK); } catch {} }

function loadCache() {
  if (!existsSync(STICKER_CACHE)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(STICKER_CACHE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { entries: {} };
  } catch { return { entries: {} }; }
}
function saveCache(obj) {
  const tmp = STICKER_CACHE + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, STICKER_CACHE);
}

function isAlreadyCached(cache, url) {
  const entries = cache.entries || {};
  if (entries[url]) return true;
  const target = stickerKey(url);
  for (const k of Object.keys(entries)) {
    if (stickerKey(k) === target) return true;
  }
  return false;
}

// ─── Download image ──────────────────────────────────────────────────────────

async function downloadToFile(url, destPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

async function fetchStickerImage(url) {
  const md5 = tryExtractMd5(url);
  const hash = shortHash(stickerKey(url));
  // The /api/image?md5= endpoint returns a JPEG served by the injected app —
  // decrypted and local. Try this first because it avoids the sign/expires
  // dance on the CDN URL.
  if (md5) {
    try {
      const dest = join(TMP_DIR, `chloe-sticker-${hash}.jpg`);
      return await downloadToFile(`${DY_BASE}/api/image?md5=${md5}`, dest);
    } catch (e) {
      console.warn("[stkintrp] /api/image failed, falling back to direct URL:", e.message);
    }
  }
  // Fallback: direct CDN fetch. Format may be JPEG/PNG/WebP.
  const ext = url.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i)?.[1]?.toLowerCase() || "jpg";
  const dest = join(TMP_DIR, `chloe-sticker-${hash}.${ext}`);
  return await downloadToFile(url, dest);
}

// ─── Interpret via hermes --image ────────────────────────────────────────────

function buildPrompt(keyword) {
  const hint = keyword ? `\n\nThe sticker's in-app keyword/text is: "${keyword}" — weave it into your description.` : "";
  return `Describe this Douyin sticker in ONE concise Chinese sentence.

Include:
- what the sticker depicts (character / object / expression)
- any Chinese text visible on it, quoted
- the vibe or intended meaning (e.g. "撒娇催促", "假装无辜", "摆烂")${hint}

Output ONLY the single sentence. No preamble, no markdown, no quotes around it.`;
}

async function runHermesVision(imagePath, prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", "chloe", "chat", "-Q",
      "--source", "chloe-sticker",
      "--image", imagePath,
      "-q", prompt,
    ];
    const child = spawn("hermes", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      env: { ...process.env, DY_MCP_ALLOWED_CONVS: "__none__" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`hermes exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      resolve(stdout);
    });
    child.on("error", reject);
  });
}

function cleanOutput(raw) {
  // Strip the session_id: header hermes -Q prints first
  let s = raw.replace(/^\s*session_id:\s*[A-Za-z0-9_]+\s*/m, "").trim();
  // Strip any <think>...</think> reasoning blocks
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "")
       .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  // Strip wrapping quotes / code fences / markdown
  s = s.replace(/^```[\w]*\n?|```$/gm, "")
       .replace(/^["'「『“]+|["'」』”]+$/g, "")
       .trim();
  // Only keep the first non-empty line (we asked for one sentence)
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { url, keyword } = parseArgs();
  if (!url) {
    console.error("[stkintrp] --url <stickerUrl> required");
    process.exit(2);
  }

  // Early out if already cached — cheap and avoids needless hermes calls.
  const earlyCache = loadCache();
  if (isAlreadyCached(earlyCache, url)) {
    console.log("[stkintrp] already cached, exiting");
    process.exit(0);
  }

  console.log(`[stkintrp] interpreting ${stickerKey(url).slice(-60)}${keyword ? ` (keyword=${keyword})` : ""}`);

  let imagePath;
  try { imagePath = await fetchStickerImage(url); }
  catch (err) {
    console.error("[stkintrp] download failed:", err.message);
    process.exit(1);
  }

  let raw;
  try { raw = await runHermesVision(imagePath, buildPrompt(keyword)); }
  catch (err) {
    console.error("[stkintrp] hermes vision failed:", err.message);
    process.exit(1);
  }

  const interpretation = cleanOutput(raw);
  if (!interpretation || interpretation.length < 4) {
    console.error("[stkintrp] empty/too-short interpretation, refusing to cache");
    process.exit(1);
  }
  // Refuse to cache text-only-model refusals (e.g. "无法分析图片" / "can't see images").
  const refusalPatterns = [
    /无法(分析|识别|看到|打开|查看)/,
    /看不(到|见|清)/,
    /打不开/,
    /(cannot|can't|unable to)\s+(see|view|analyze|open|access|process)/i,
    /no\s+image\s+(was\s+)?(provided|attached|received)/i,
    /技术问题/,
  ];
  if (refusalPatterns.some(re => re.test(interpretation))) {
    console.error(`[stkintrp] model refusal detected, not caching: ${interpretation.slice(0, 120)}`);
    process.exit(1);
  }

  const got = await acquireCacheLock();
  try {
    const cache = loadCache();
    cache.entries = cache.entries || {};
    const key = stickerKey(url);
    // Cache under both the original URL (exact-hit optimization) and the
    // normalized key (so expiring URL variants match).
    const entry = {
      interpretation,
      keyword: keyword || "",
      cached_at: new Date().toISOString(),
    };
    cache.entries[url] = entry;
    cache.entries[key] = entry;
    saveCache(cache);
    console.log(`[stkintrp] cached: ${interpretation}`);
  } finally {
    if (got) releaseCacheLock();
  }
  process.exit(0);
}

main().catch(err => {
  console.error("[stkintrp] fatal:", err);
  process.exit(1);
});

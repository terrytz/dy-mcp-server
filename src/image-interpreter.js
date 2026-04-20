#!/usr/bin/env node
/**
 * image-interpreter.js — background vision subagent that interprets a Douyin
 * chat image (type 27) and writes the result to image-cache.json.
 *
 * Spawned detached by bridge.js:
 *   node image-interpreter.js --md5 <imageMd5> [--url <fallbackCdnUrl>]
 *
 * Flow mirrors sticker-interpreter.js — the cache is keyed by md5 because
 * that's the only stable handle (CDN URLs carry time-bound signatures).
 *
 *   1. If md5 already cached → exit.
 *   2. Acquire per-md5 lock so duplicate fires don't race.
 *   3. Download image bytes — first via /api/image?md5=<md5> (decrypted + local),
 *      fallback to the provided CDN URL if given.
 *   4. Call `hermes -p chloe chat --image <path> -q "..."` to describe it.
 *   5. Clean the output and write it into image-cache.json.
 *
 * Fire-and-forget: on any failure we just skip this image; the responder
 * will surface "[image (uncached)]" and memory-updater can try next round.
 */

import {
  readFileSync, writeFileSync, existsSync, renameSync,
  mkdirSync, rmdirSync, unlinkSync,
} from "node:fs";
import { spawn, execSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";

const PROFILE_DIR = loadConfig().profileDir;
const IMAGE_CACHE = join(PROFILE_DIR, "image-cache.json");
const CACHE_LOCK = "/tmp/dy-image-cache.lock";
const TMP_DIR = "/tmp";
const DY_BASE = "http://127.0.0.1:3456";

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let md5 = null;
  let url = "";
  let convId = "";
  let skey = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--md5" && args[i + 1]) { md5 = args[i + 1]; i++; }
    else if (args[i] === "--url" && args[i + 1]) { url = args[i + 1]; i++; }
    else if (args[i] === "--conv" && args[i + 1]) { convId = args[i + 1]; i++; }
    else if (args[i] === "--skey" && args[i + 1]) { skey = args[i + 1]; i++; }
  }
  return { md5, url, convId, skey };
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
  if (!existsSync(IMAGE_CACHE)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(IMAGE_CACHE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { entries: {} };
  } catch { return { entries: {} }; }
}
function saveCache(obj) {
  const tmp = IMAGE_CACHE + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, IMAGE_CACHE);
}

function isAlreadyCached(cache, md5) {
  const entries = cache.entries || {};
  return Boolean(entries[md5]);
}

// ─── Download image ──────────────────────────────────────────────────────────

// Douyin's /api/image may return the original format (heic/webp/jpeg) plus an
// `x-image-format` header. Vision models only reliably accept JPEG/PNG, so we
// normalize via `sips` (macOS) when needed. We also pass convId because the
// injected app uses it to look up the per-message skey for decryption — without
// it the response can come back as encrypted raw bytes.

async function fetchImageFromDy(md5, convId) {
  const params = new URLSearchParams({ md5 });
  if (convId) params.set("convId", convId);
  const res = await fetch(`${DY_BASE}/api/image?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `dy /api/image ${res.status}`);
  }
  const format = (res.headers.get("x-image-format") || "jpeg").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, format };
}

async function fetchImageFromDyForce(md5, convId, skey, url) {
  // /api/image/force probes plausible IPC methods to trigger the IM SDK's own
  // download+decrypt, then polls the local cache. Returns image bytes on hit,
  // or a JSON body with an attempts[] diagnostic on 404.
  const res = await fetch(`${DY_BASE}/api/image/force`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ md5, convId, skey, url, variant: "large", maxWaitMs: 12_000 }),
  });
  if (!res.ok) {
    let detail = `status ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.attempts) {
        const ok = j.attempts.filter((a) => a.ok).map((a) => a.method);
        const errs = j.attempts
          .filter((a) => !a.ok)
          .slice(0, 5)
          .map((a) => `${a.method}: ${a.error}`);
        detail = `${j.error || detail}; succeeded=[${ok.join(", ")}]; first errors: ${errs.join(" | ")}`;
      } else if (j && j.error) {
        detail = j.error;
      }
    } catch {}
    throw new Error(`dy /api/image/force ${detail}`);
  }
  const format = (res.headers.get("x-image-format") || "jpeg").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, format };
}

async function fetchImageFromCdn(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`CDN fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Best-effort format guess from URL suffix.
  const ext = url.match(/\.(jpe?g|png|webp|gif|heic)(?:\?|$)/i)?.[1]?.toLowerCase() || "jpeg";
  return { buf, format: ext === "jpg" ? "jpeg" : ext };
}

function ensureJpeg(buf, format, md5) {
  const outJpeg = join(TMP_DIR, `dy-image-${md5}.jpg`);
  // Already JPEG or PNG? Most VL models accept both — save as-is.
  if (format === "jpeg" || format === "jpg") {
    writeFileSync(outJpeg, buf);
    return outJpeg;
  }
  if (format === "png") {
    const outPng = join(TMP_DIR, `dy-image-${md5}.png`);
    writeFileSync(outPng, buf);
    return outPng;
  }
  // heic / webp / gif → convert to jpeg via sips
  const srcPath = join(TMP_DIR, `dy-image-${md5}.${format}`);
  writeFileSync(srcPath, buf);
  try {
    execSync(`sips -s format jpeg "${srcPath}" --out "${outJpeg}" 2>/dev/null`);
  } catch (e) {
    throw new Error(`sips conversion ${format}→jpeg failed: ${e.message}`);
  }
  try { unlinkSync(srcPath); } catch {}
  return outJpeg;
}

async function fetchImage(md5, fallbackUrl, convId, skey) {
  // Preferred order:
  //   1. /api/image — if the user already viewed the message, it's in the local cache.
  //   2. /api/image/force — ask the injected api-server to trigger a download via IPC.
  //   3. Raw CDN URL — fails validation because these bytes are still encrypted,
  //      but kept as a last resort in case the route isn't installed.
  let buf, format;
  try {
    ({ buf, format } = await fetchImageFromDy(md5, convId));
  } catch (e) {
    console.warn("[imgintrp] /api/image miss (%s), trying /api/image/force", e.message);
    try {
      ({ buf, format } = await fetchImageFromDyForce(md5, convId, skey, fallbackUrl));
    } catch (e2) {
      console.warn("[imgintrp] /api/image/force failed: %s", e2.message);
      if (!fallbackUrl) throw e2;
      console.warn("[imgintrp] trying raw CDN URL as last resort (bytes likely encrypted)");
      ({ buf, format } = await fetchImageFromCdn(fallbackUrl));
    }
  }
  const path = ensureJpeg(buf, format, md5);
  // Sanity check: real JPEG starts with ffd8ff; PNG with 89504e47. If the
  // first bytes look random, it's almost certainly still-encrypted Douyin
  // payload — fail loudly so we don't feed garbage to the vision model.
  const head = readFileSync(path).slice(0, 4);
  const hex = head.toString("hex");
  const isJpeg = hex.startsWith("ffd8ff");
  const isPng = hex.startsWith("89504e47");
  if (!isJpeg && !isPng) {
    throw new Error(`downloaded bytes not a valid image (magic=${hex}, format=${format}) — likely encrypted; check that convId is being passed to /api/image`);
  }
  console.log(`[imgintrp] image ready: ${path} (format=${format}, ${buf.length} bytes)`);
  return path;
}

// ─── Interpret via hermes --image ────────────────────────────────────────────

function buildPrompt() {
  return `Describe this chat image in 1-3 concise Chinese sentences.

Cover whatever is useful for a friend to react naturally:
- What the image shows (photo / screenshot / document / meme / selfie / food / etc.)
- Any Chinese (or English) text that is clearly readable, quoted verbatim
- The apparent context or mood if it's obvious (e.g. "吐槽截图", "晒娃", "点餐单", "报警单据")

Keep it factual — no embellishment, no guessing at intent beyond what the image plainly shows. No preamble, no markdown, no quotes around it. Just the sentence(s).`;
}

async function runHermesVision(imagePath, prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", loadConfig().hermesProfile, "chat", "-Q",
      "--source", "dy-image",
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
  let s = raw.replace(/^\s*session_id:\s*[A-Za-z0-9_]+\s*/m, "").trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "")
       .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  s = s.replace(/^```[\w]*\n?|```$/gm, "")
       .replace(/^["'「『“]+|["'」』”]+$/g, "")
       .trim();
  // Collapse to at most ~3 lines of meaningful text.
  const lines = s.split("\n").map(l => l.trim()).filter(Boolean);
  return lines.slice(0, 3).join(" ").trim();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { md5, url, convId, skey } = parseArgs();
  if (!md5) {
    console.error("[imgintrp] --md5 <imageMd5> required");
    process.exit(2);
  }

  const earlyCache = loadCache();
  if (isAlreadyCached(earlyCache, md5)) {
    console.log("[imgintrp] already cached, exiting");
    process.exit(0);
  }

  console.log(`[imgintrp] interpreting image md5=${md5}${convId ? ` conv=${convId}` : ""}${skey ? " skey=…" : ""}`);

  let imagePath;
  try { imagePath = await fetchImage(md5, url, convId, skey); }
  catch (err) {
    console.error("[imgintrp] download failed:", err.message);
    process.exit(1);
  }

  let raw;
  try { raw = await runHermesVision(imagePath, buildPrompt()); }
  catch (err) {
    console.error("[imgintrp] hermes vision failed:", err.message);
    process.exit(1);
  }

  const description = cleanOutput(raw);
  if (!description || description.length < 4) {
    console.error("[imgintrp] empty/too-short description, refusing to cache");
    process.exit(1);
  }
  // Detect text-only-model refusals (common when auxiliary.vision points at a
  // non-VL model — the bytes are dropped and the model just apologizes). Never
  // cache these; let the next attempt retry once the VL model is wired up.
  const refusalPatterns = [
    /无法(分析|识别|看到|打开|查看)/,
    /看不(到|见|清)/,
    /打不开/,
    /(cannot|can't|unable to)\s+(see|view|analyze|open|access|process)/i,
    /not\s+able\s+to\s+(see|view|analyze)/i,
    /no\s+image\s+(was\s+)?(provided|attached|received)/i,
    /我(这边)?(也)?(看不到|看不见|没办法)/,
    /技术问题/,
  ];
  if (refusalPatterns.some(re => re.test(description))) {
    console.error(`[imgintrp] model refusal detected, not caching: ${description.slice(0, 120)}`);
    process.exit(1);
  }

  const got = await acquireCacheLock();
  try {
    const cache = loadCache();
    cache.entries = cache.entries || {};
    cache.entries[md5] = {
      description,
      cached_at: new Date().toISOString(),
    };
    saveCache(cache);
    console.log(`[imgintrp] cached: ${description.slice(0, 120)}`);
  } finally {
    if (got) releaseCacheLock();
  }
  process.exit(0);
}

main().catch(err => {
  console.error("[imgintrp] fatal:", err);
  process.exit(1);
});

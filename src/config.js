/**
 * config.js — shared configuration loader.
 *
 * Reads identity and credentials from (in priority order):
 *   1. Environment variables (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DY_PROFILE_DIR, DY_CONFIG_PATH)
 *   2. $DY_CONFIG_PATH or <repo>/config.json (gitignored — per-deployment)
 *   3. <repo>/config.example.json (committed defaults)
 *   4. $DY_PROFILE_DIR/chat-config.json (live runtime config written by setup wizard)
 *
 * Every public identifier (owner name, persona name, signature, Telegram
 * credentials) must come from here — never hardcode personal strings.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function firstExisting(paths) {
  for (const p of paths) {
    if (!p) continue;
    const data = readJson(p);
    if (data) return data;
  }
  return {};
}

export function loadConfig() {
  // Project-level config: identity, credentials, profile path.
  const project = firstExisting([
    process.env.DY_CONFIG_PATH,
    join(REPO_ROOT, "config.json"),
    join(REPO_ROOT, "config.example.json"),
  ]);

  const profileDir = expandHome(
    process.env.DY_PROFILE_DIR
    || project.profileDir
    || join(homedir(), ".dy-mcp-server", "profile")
  );
  const profileConfigPath = join(profileDir, "chat-config.json");

  // Runtime config (allowed chats etc.) lives in the profile directory so the
  // setup wizard can rewrite it without touching the repo.
  const profile = readJson(profileConfigPath) || {};

  const personaName = project.personaName || profile.personaName || "Bot";
  const triggerName = String(
    project.triggerName || profile.triggerName || personaName
  ).toLowerCase();
  const signature = project.signature || profile.signature || `[${personaName}]`;

  return {
    ownerName: project.ownerName || profile.ownerName || "User",
    personaName,
    triggerName,
    signature,
    defaultModel: project.defaultModel || profile.defaultModel || "sonnet",
    hermesProfile: project.hermesProfile || profile.hermesProfile || personaName.toLowerCase(),
    profileDir,
    profileConfigPath,
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || project.telegram?.botToken || "",
      chatId: process.env.TELEGRAM_CHAT_ID || project.telegram?.chatId || "",
    },
    allowedChats: project.allowedChats ?? profile.allowedChats ?? {},
    blockedUsers: project.blockedUsers ?? profile.blockedUsers ?? {},
  };
}

export function repoRoot() { return REPO_ROOT; }
export function profileDir() { return loadConfig().profileDir; }

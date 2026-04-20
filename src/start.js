#!/usr/bin/env node
/**
 * start.js — unified entry point for dy-mcp-server
 *
 * Spawns two child processes:
 *   1. MCP server  (stdio server for Hermes)
 *   2. Bridge      (Douyin listener + brain + responder)
 *
 * Both share the same log prefix so it's easy to trace.
 * Exit when any child dies (restart policy TBD later).
 */

import { spawn, fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const LOG_PREFIX = "[dy-start]";

const children = new Set();

// ─── Spawn helpers ──────────────────────────────────────────────────────────

function spawnMcp() {
  console.log(`${LOG_PREFIX} spawning MCP server (stdio)...`);
  const child = spawn("node", ["index.js"], {
    cwd: DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  child.stdout.on("data", d => process.stdout.write(`[dy-mcp] ${d}`));
  child.stderr.on("data", d => process.stderr.write(`[dy-mcp] ${d}`));
  child.on("close", code => {
    console.log(`${LOG_PREFIX} MCP server exited with code ${code}`);
    children.delete(child);
  });
  children.add(child);
  return child;
}

function spawnBridge() {
  console.log(`${LOG_PREFIX} spawning bridge (Douyin listener)...`);
  const child = spawn("node", ["bridge.js"], {
    cwd: DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  child.stdout.on("data", d => process.stdout.write(`[dy-bridge] ${d}`));
  child.stderr.on("data", d => process.stderr.write(`[dy-bridge] ${d}`));
  child.on("close", code => {
    console.log(`${LOG_PREFIX} bridge exited with code ${code}`);
    children.delete(child);
  });
  children.add(child);
  return child;
}

// ─── Signal handling ─────────────────────────────────────────────────────────

function killAll() {
  for (const child of children) {
    console.log(`${LOG_PREFIX} killing ${child.pid}...`);
    child.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  console.log(`${LOG_PREFIX} SIGINT received`);
  killAll();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log(`${LOG_PREFIX} SIGTERM received`);
  killAll();
  process.exit(0);
});

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { loadConfig } = await import("./config.js");
  const cfg = loadConfig();
  console.log(`${LOG_PREFIX} dy-mcp-server starting...`);
  console.log(`${LOG_PREFIX} log: /tmp/dy-messages.jsonl`);
  console.log(`${LOG_PREFIX} memory: ${cfg.profileDir}/memories/`);

  spawnMcp();
  spawnBridge();

  console.log(`${LOG_PREFIX} both processes running — ctrl-c to stop`);
}

main().catch(err => {
  console.error(`${LOG_PREFIX} Fatal:`, err);
  process.exit(1);
});

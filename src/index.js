#!/usr/bin/env node
/**
 * dy-mcp-server — MCP server for 抖音聊天 (Douyin Chat)
 *
 * Wraps the injected HTTP API at http://127.0.0.1:3456 (from the asar-patched app)
 * and exposes it as an MCP tool server.
 *
 * Start:  node src/index.js
 * Config: add to ~/.hermes/config.yaml under mcp_servers
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = "http://127.0.0.1:3456";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `API error ${res.status} on ${path}`);
  }
  return data;
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "dy_health",
    description: "Check if the Douyin Chat API server is running and healthy.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dy_user",
    description: "Get the currently logged-in Douyin user (UID, nickname, etc.).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dy_conversations",
    description: "List all visible conversations (groups and DMs). Returns id, type, name for each.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dy_messages",
    description: "Fetch recent messages from a specific conversation.",
    inputSchema: {
      type: "object",
      required: ["convId"],
      properties: {
        convId: { type: "string", description: "Conversation ID" },
        limit: { type: "number", description: "Max messages to fetch (default 20, max 100)", default: 20 },
        cursor: { type: "string", description: "Pagination cursor (from previous response)" },
      },
    },
  },
  {
    name: "dy_send",
    description: "Send a text message to a conversation.",
    inputSchema: {
      type: "object",
      required: ["convId", "text"],
      properties: {
        convId: { type: "string", description: "Conversation ID" },
        text: { type: "string", description: "Message text to send" },
      },
    },
  },
  {
    name: "dy_conv",
    description: "Get conversation detail (info + member list) for a given conversation.",
    inputSchema: {
      type: "object",
      required: ["convId"],
      properties: {
        convId: { type: "string", description: "Conversation ID" },
      },
    },
  },
  {
    name: "dy_members",
    description: "Get the member list of a conversation.",
    inputSchema: {
      type: "object",
      required: ["convId"],
      properties: {
        convId: { type: "string", description: "Conversation ID" },
      },
    },
  },
  {
    name: "dy_image",
    description: "Download and convert a chat image to JPEG. Returns the local file path.",
    inputSchema: {
      type: "object",
      required: ["md5"],
      properties: {
        md5: { type: "string", description: "Image MD5 cache key (from message imageMd5 field)" },
        convId: { type: "string", description: "Optional conversation ID for CDN URL resolution" },
      },
    },
  },
  {
    name: "dy_search",
    description: "Search messages across all conversations.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query text" },
      },
    },
  },
  {
    name: "dy_peek",
    description: "Check if there are new (unread) messages in a conversation without consuming them. Useful before sending to avoid double-posting.",
    inputSchema: {
      type: "object",
      required: ["convId"],
      properties: {
        convId: { type: "string", description: "Conversation ID" },
      },
    },
  },
];

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {
    case "dy_health": {
      const res = await fetch(`${BASE}/health`);
      const data = await res.json();
      return [{ type: "text", text: JSON.stringify(data) }];
    }

    case "dy_user": {
      const data = await api("/api/user");
      return [{ type: "text", text: JSON.stringify(data.data, null, 2) }];
    }

    case "dy_conversations": {
      const data = await api("/api/conversations");
      const convs = (data.data || []).map((c) => ({
        id: c.conversationId || c.convId,
        type: c.type === 1 ? "DM" : "Group",
        name: c.name || c.nickname || c.conversationId || "Unknown",
      }));
      return [{ type: "text", text: JSON.stringify(convs, null, 2) }];
    }

    case "dy_messages": {
      const { convId, limit = 20, cursor } = args;
      const params = new URLSearchParams({ convId, limit: String(Math.min(limit, 100)) });
      if (cursor) params.set("cursor", cursor);
      const data = await api(`/api/messages?${params}`);
      const messages = (data.data?.messages || []).map((m) => {
        const pc = m.parsedContent || {};
        return {
          sender: m.sender,
          type: m.type,
          text: pc.text || "",
          stickerUrl: pc.url?.url_list?.[0] || "",
          stickerKeyword: pc.display_name || "",
          imageMd5: pc.resource_url?.md5 || "",
          videoTitle: pc.content_title || "",
          videoAuthor: pc.content_name || "",
          createdAt: m.createdAt,
        };
      });
      return [{ type: "text", text: JSON.stringify({ messages, hasPre: data.data?.hasPre }, null, 2) }];
    }

    case "dy_send": {
      const { convId, text } = args;
      // Cross-conversation isolation: when DY_MCP_ALLOWED_CONVS is set,
      // dy_send is restricted to the listed conv(s). Sentinel "__none__"
      // blocks everything. Unset = unrestricted (cron-fired sessions).
      const allow = (process.env.DY_MCP_ALLOWED_CONVS || "").trim();
      if (allow) {
        const list = allow.split(",").map(s => s.trim()).filter(Boolean);
        if (list.includes("__none__") || !list.includes(convId)) {
          throw new Error("dy_send blocked: target conversation not permitted in this session");
        }
      }
      const data = await api("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ convId, text }),
      });
      return [{ type: "text", text: JSON.stringify(data, null, 2) }];
    }

    case "dy_conv": {
      const { convId } = args;
      const data = await api(`/api/conv?convId=${encodeURIComponent(convId)}`);
      return [{ type: "text", text: JSON.stringify(data.data, null, 2) }];
    }

    case "dy_members": {
      const { convId } = args;
      const data = await api(`/api/conv?convId=${encodeURIComponent(convId)}`);
      const members = data.data?.members || [];
      return [{ type: "text", text: JSON.stringify(members, null, 2) }];
    }

    case "dy_image": {
      const { md5, convId } = args;
      const params = new URLSearchParams({ md5 });
      if (convId) params.set("convId", convId);
      const res = await fetch(`${BASE}/api/image?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Image fetch failed: ${res.status}`);
      }
      // The API returns binary image data with Content-Type header indicating format
      const format = res.headers.get("x-image-format") || "jpeg";
      const buf = Buffer.from(await res.arrayBuffer());

      // Write to /tmp/dy-images/ with correct extension
      const { mkdirSync, existsSync, writeFileSync } = await import("node:fs");
      const cacheDir = "/tmp/dy-images";
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
      const ext = format === "heic" ? "heic" : format === "webp" ? "webp" : "jpg";
      const outPath = `${cacheDir}/${md5}.${ext}`;

      // Convert HEIC/WebP to JPEG using sips if needed
      if (format === "heic" || format === "webp") {
        const tmpPath = `${cacheDir}/${md5}.${format === "heic" ? "heic" : "webp"}`;
        writeFileSync(tmpPath, buf);
        try {
          const { execSync } = await import("node:child_process");
          execSync(`sips -s format jpeg "${tmpPath}" --out "${outPath}" 2>/dev/null`);
        } catch {
          // sips failed, return the original file
          return [{ type: "text", text: tmpPath }];
        }
      } else {
        writeFileSync(outPath, buf);
      }
      return [{ type: "text", text: outPath }];
    }

    case "dy_search": {
      const { query } = args;
      const data = await api(`/api/search?query=${encodeURIComponent(query)}`);
      return [{ type: "text", text: JSON.stringify(data.data, null, 2) }];
    }

    case "dy_peek": {
      // Peek reads the jsonl log directly (same logic as cli.js peek-conv)
      const { convId } = args;
      const { readFileSync, existsSync, statSync } = await import("node:fs");
      const LOG = "/tmp/dy-messages.jsonl";
      const CURSOR = `/tmp/dy-mcp-peek-${convId}.cursor`;
      if (!existsSync(LOG)) return [{ type: "text", text: JSON.stringify({ hasNew: false, count: 0 }) }];

      let cursor = 0;
      try { cursor = parseInt(readFileSync(CURSOR, "utf8").trim()) || 0; } catch {}
      const size = statSync(LOG).size;
      if (size <= cursor) return [{ type: "text", text: JSON.stringify({ hasNew: false, count: 0 }) }];

      const fd = await import("node:fs").then(m => {
        const fd_ = m.openSync(LOG, "r");
        const buf = Buffer.alloc(size - cursor);
        m.readSync(fd_, buf, 0, buf.length, cursor);
        m.closeSync(fd_);
        return buf.toString();
      });

      const count = fd.trim().split("\n").filter(Boolean).filter(line => {
        try {
          const m = JSON.parse(line);
          if (m.convId !== convId) return false;
          if (m.text && m.text.endsWith("[🎈Chloe🧸]")) return false; // bot's own signature
          return true;
        } catch { return false; }
      }).length;

      return [{ type: "text", text: JSON.stringify({ hasNew: count > 0, count }) }];
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "dy-mcp-server", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const result = await handleTool(name, args);
    return { content: result };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error("Failed to connect transport:", err);
  process.exit(1);
});

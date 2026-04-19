#!/usr/bin/env bash
set -euo pipefail

# dy-chat-bot installer
# Creates cross-platform agent skill symlinks from this repo's skills/ directory.
# Supports 44 AI coding agents including Claude Code, Cursor, Trae, Windsurf, etc.
#
# Usage:
#   ./install.sh          # project-local install
#   ./install.sh -g       # global install (~/.agents/skills)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SRC="$SCRIPT_DIR/skills"
GLOBAL="${1:-}"

if [ ! -d "$SKILLS_SRC" ]; then
  echo "Error: skills/ directory not found at $SKILLS_SRC"
  exit 1
fi

# --- Determine install scope ---

if [ "$GLOBAL" = "-g" ] || [ "$GLOBAL" = "--global" ]; then
  SCOPE="global"
  CANONICAL="$HOME/.agents/skills"

  # Global agent directories that need symlinks (only if they exist)
  # Format: parent_dir:skills_subpath
  AGENT_GLOBALS=(
    "$HOME/.claude:skills"
    "$HOME/.trae:skills"
    "$HOME/.trae-cn:skills"
    "$HOME/.codeium/windsurf:skills"
    "$HOME/.config/goose:skills"
    "$HOME/.roo:skills"
    "$HOME/.continue:skills"
    "$HOME/.augment:skills"
    "$HOME/.adal:skills"
    "$HOME/.codebuddy:skills"
    "$HOME/.commandcode:skills"
    "$HOME/.snowflake/cortex:skills"
    "$HOME/.config/crush:skills"
    "$HOME/.factory:skills"
    "$HOME/.iflow:skills"
    "$HOME/.junie:skills"
    "$HOME/.kilocode:skills"
    "$HOME/.kiro:skills"
    "$HOME/.kode:skills"
    "$HOME/.mcpjam:skills"
    "$HOME/.vibe:skills"
    "$HOME/.mux:skills"
    "$HOME/.neovate:skills"
    "$HOME/.openclaw:skills"
    "$HOME/.openhands:skills"
    "$HOME/.pi/agent:skills"
    "$HOME/.pochi:skills"
    "$HOME/.qoder:skills"
    "$HOME/.qwen:skills"
    "$HOME/.zencoder:skills"
    "$HOME/.codex:skills"
    "$HOME/.cursor:skills"
    "$HOME/.copilot:skills"
    "$HOME/.gemini:skills"
    "$HOME/.gemini/antigravity:skills"
    "$HOME/.deepagents/agent:skills"
    "$HOME/.firebender:skills"
    "$HOME/.config/agents:skills"
    "$HOME/.config/opencode:skills"
  )
else
  SCOPE="local"
  CANONICAL="$SCRIPT_DIR/.agents/skills"

  # Project-level agent directories that need their own symlinks
  # (agents reading .agents/skills/ directly don't need these)
  AGENT_LOCALS=(
    "$SCRIPT_DIR/.claude:skills"
    "$SCRIPT_DIR/.trae:skills"
    "$SCRIPT_DIR/.windsurf:skills"
    "$SCRIPT_DIR/.goose:skills"
    "$SCRIPT_DIR/.roo:skills"
    "$SCRIPT_DIR/.continue:skills"
    "$SCRIPT_DIR/.augment:skills"
    "$SCRIPT_DIR/.adal:skills"
    "$SCRIPT_DIR/.codebuddy:skills"
    "$SCRIPT_DIR/.commandcode:skills"
    "$SCRIPT_DIR/.cortex:skills"
    "$SCRIPT_DIR/.crush:skills"
    "$SCRIPT_DIR/.factory:skills"
    "$SCRIPT_DIR/.iflow:skills"
    "$SCRIPT_DIR/.junie:skills"
    "$SCRIPT_DIR/.kilocode:skills"
    "$SCRIPT_DIR/.kiro:skills"
    "$SCRIPT_DIR/.kode:skills"
    "$SCRIPT_DIR/.mcpjam:skills"
    "$SCRIPT_DIR/.vibe:skills"
    "$SCRIPT_DIR/.mux:skills"
    "$SCRIPT_DIR/.neovate:skills"
    "$SCRIPT_DIR/.openhands:skills"
    "$SCRIPT_DIR/.pi:skills"
    "$SCRIPT_DIR/.pochi:skills"
    "$SCRIPT_DIR/.qoder:skills"
    "$SCRIPT_DIR/.qwen:skills"
    "$SCRIPT_DIR/.zencoder:skills"
  )
fi

echo "Installing dy-chat-bot skills ($SCOPE)..."
echo ""

# --- Save project path ---

echo "$SCRIPT_DIR" > "$HOME/.dy-chat-bot-path"
echo "  Saved project path → ~/.dy-chat-bot-path"

# --- Create AGENTS.md symlink from CLAUDE.md ---

if [ -f "$SCRIPT_DIR/CLAUDE.md" ] && [ ! -e "$SCRIPT_DIR/AGENTS.md" ]; then
  ln -sf CLAUDE.md "$SCRIPT_DIR/AGENTS.md"
  echo "  Linked AGENTS.md → CLAUDE.md"
fi

# --- Copy skills to canonical .agents/skills/ ---

mkdir -p "$CANONICAL"
SKILL_NAMES=()
for skill_dir in "$SKILLS_SRC"/*/; do
  [ -f "$skill_dir/SKILL.md" ] || continue
  name="$(basename "$skill_dir")"
  SKILL_NAMES+=("$name")
  mkdir -p "$CANONICAL/$name"
  cp "$skill_dir/SKILL.md" "$CANONICAL/$name/SKILL.md"
done

echo "  Copied ${#SKILL_NAMES[@]} skills → $CANONICAL"

# --- Create agent symlinks ---

link_count=0

if [ "$SCOPE" = "global" ]; then
  AGENTS=("${AGENT_GLOBALS[@]}")
else
  AGENTS=("${AGENT_LOCALS[@]}")
fi

for entry in "${AGENTS[@]}"; do
  parent="${entry%%:*}"
  subpath="${entry##*:}"

  # Global: only link agents that are actually installed
  # Local: create all agent dirs (lightweight symlinks, any agent opening this project finds skills)
  if [ "$SCOPE" = "global" ]; then
    [ -d "$parent" ] || continue
  fi

  skills_dir="$parent/$subpath"
  mkdir -p "$skills_dir"

  for name in "${SKILL_NAMES[@]}"; do
    # Remove existing symlink/dir if present, then create fresh symlink
    rm -rf "$skills_dir/$name" 2>/dev/null || true
    ln -sf "$CANONICAL/$name" "$skills_dir/$name"
  done

  # Show short path for readability
  short="${parent/$HOME/~}"
  echo "  Linked → $short/$subpath/"
  link_count=$((link_count + 1))
done

echo ""
echo "Done! ${#SKILL_NAMES[@]} skills installed, $link_count agent(s) linked."
echo ""
echo "Skills: ${SKILL_NAMES[*]}"
echo ""
echo "Next: run /dy-setup in your AI agent to configure the bot."

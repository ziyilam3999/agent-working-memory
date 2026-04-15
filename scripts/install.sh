#!/usr/bin/env bash
# Installer for agent-working-memory.
#
# What it does:
#   1. Creates $WORKING_MEMORY_ROOT (default: $HOME/.claude/agent-working-memory)
#   2. Creates the tier-b/topics/ subtree
#   3. Writes a seed tier-a.md placeholder
#   4. Prints a summary and next-step hint
#
# What it does NOT do (those are later phases):
#   - Create or push to any private content repo
#   - Write any real decision cards
#   - Install hooks into Claude Code's global settings
#   - Require the user to pre-set WORKING_MEMORY_ROOT

set -euo pipefail

ROOT="${WORKING_MEMORY_ROOT:-$HOME/.claude/agent-working-memory}"

mkdir -p "$ROOT/tier-b/topics"

if [ ! -f "$ROOT/tier-a.md" ]; then
  cat > "$ROOT/tier-a.md" <<'EOF'
# Tier A — Pocket Card

(empty — run `memory write` to add your first decision card, then `memory refresh`)
EOF
fi

echo "installed: $ROOT"
echo "  tier-b/topics/: $(ls -1 "$ROOT/tier-b/topics" | wc -l) topic(s)"
echo "  tier-a.md: $(wc -c < "$ROOT/tier-a.md") bytes"
echo ""
echo "next: memory write --topic demo --id first --title 'my first decision'"

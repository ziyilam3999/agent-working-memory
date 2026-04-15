#!/usr/bin/env bash
# SessionStart hook: rebuild tier-a.md from tier-b and emit it to stdout.
# Claude Code's SessionStart hook protocol expects stdout content to be injected
# into the session context.
#
# Standalone invocation (for AC-5 verification):
#   WORKING_MEMORY_ROOT=/path/to/fixture bash hooks/session-start.sh
#
# If WORKING_MEMORY_ROOT is unset, the default ($HOME/.claude/agent-working-memory)
# is used. The hook emits nothing and exits 0 if the root does not exist yet
# (first run, before installer) so it never blocks a session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ROOT="${WORKING_MEMORY_ROOT:-$HOME/.claude/agent-working-memory}"

if [ ! -d "$ROOT/tier-b" ]; then
  exit 0
fi

# Rebuild tier-a.md in place, then emit it.
node "$REPO_ROOT/src/refresh.mjs" --root "$ROOT" >/dev/null
cat "$ROOT/tier-a.md"

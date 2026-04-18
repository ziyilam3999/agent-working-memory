// Refresh: rebuild tier-a.md from the tier-b tree under $WORKING_MEMORY_ROOT.
// Usage:
//   node src/refresh.mjs [--root PATH] [--budget BYTES] [--dry-run]
// If --root is omitted, uses $WORKING_MEMORY_ROOT or the default under $HOME/.claude/.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadCards, compact, DEFAULT_BUDGET } from "./compact.mjs";

// Guard against shell tokens that were never expanded by the parent process
// (e.g. Claude Code's env block ships literal values, so a config like
// "$HOME/.claude/agent-working-memory" leaks the $HOME token into this
// process). Writing to such a path creates a bogus directory named $HOME
// under the current working directory. Refuse loudly instead of silently
// misrouting writes. See plan:
//   forge-harness/.ai-workspace/plans/2026-04-19-memory-cli-home-leak-fix.md
const UNEXPANDED_TOKEN_RE = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;

function assertExpandedPath(candidate, source) {
  const match = UNEXPANDED_TOKEN_RE.exec(candidate);
  if (match) {
    throw new Error(
      `resolveRoot: ${source} contains an unexpanded shell token (${match[0]}) in value ` +
      `"${candidate}". Refusing to return a path with a literal $VAR — writing to it ` +
      `would create a bogus directory under CWD. Fix: unset the env var so the default ` +
      `${'$'}HOME-based fallback fires, or pass a fully-expanded absolute path.`,
    );
  }
  return candidate;
}

export function resolveRoot(argRoot) {
  if (argRoot) return assertExpandedPath(argRoot, "argRoot");
  if (process.env.WORKING_MEMORY_ROOT) {
    return assertExpandedPath(process.env.WORKING_MEMORY_ROOT, "WORKING_MEMORY_ROOT env var");
  }
  return join(homedir(), ".claude", "agent-working-memory");
}

export function refresh({ root, budget = DEFAULT_BUDGET, dryRun = false } = {}) {
  const tierBRoot = join(root, "tier-b");
  const cards = loadCards(tierBRoot);
  const tierA = compact(cards, { budget });
  const outPath = join(root, "tier-a.md");
  if (!dryRun) {
    mkdirSync(root, { recursive: true });
    writeFileSync(outPath, tierA, "utf8");
  }
  return { outPath, bytes: Buffer.byteLength(tierA, "utf8"), cardCount: cards.length, content: tierA };
}

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a === "--budget") out.budget = parseInt(argv[++i], 10);
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("refresh.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot(args.root);
  const res = refresh({ root, budget: args.budget, dryRun: args.dryRun });
  process.stdout.write(`refreshed ${res.outPath} (${res.bytes} bytes, ${res.cardCount} cards)\n`);
}

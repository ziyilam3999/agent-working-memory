// Refresh: rebuild tier-a.md from the tier-b tree under $WORKING_MEMORY_ROOT.
// Usage:
//   node src/refresh.mjs [--root PATH] [--budget BYTES] [--dry-run]
// If --root is omitted, uses $WORKING_MEMORY_ROOT or the default under $HOME/.claude/.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadCards, compact, DEFAULT_BUDGET } from "./compact.mjs";

export function resolveRoot(argRoot) {
  if (argRoot) return argRoot;
  if (process.env.WORKING_MEMORY_ROOT) return process.env.WORKING_MEMORY_ROOT;
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

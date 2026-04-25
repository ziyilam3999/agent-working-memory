// Refresh: rebuild tier-a.md from the tier-b tree under $WORKING_MEMORY_ROOT.
// Usage:
//   node src/refresh.mjs [--root PATH] [--budget BYTES] [--dry-run]
//                        [--status-fragment PATH]
// If --root is omitted, uses $WORKING_MEMORY_ROOT or the default under $HOME/.claude/.
//
// Memory-liveness fragment include (PR-B AC B7):
//   refresh() also consumes a Cairn-written status fragment (PR A's
//   producer at cairn/bin/cairn-liveness.mjs) and embeds it in tier-a.md
//   with four-branch graceful behavior:
//     (a) present and fresh (anchor + mtime within freshness window) → embed
//     (b) absent → no embed, no error
//     (c) malformed (anchor missing) → no embed, optional one-line note
//     (d) stale (anchor present, mtime older than window) → embed WITH age
//         annotation
//
// The fragment path defaults to $CAIRN_STATUS_FRAGMENT or
// $HOME/.claude/cairn/status-fragment.md, matching PR A's writer.

import { writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
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

// Memory-liveness fragment freshness window. PR A's H7 cron fires every 6h
// and its heartbeat-reader uses an 8h window — adopt the same value here so
// "fresh by Cairn's lights" and "fresh by the consumer's lights" agree.
const FRAGMENT_FRESHNESS_MS = 8 * 60 * 60 * 1000;

// Stable anchor heading the producer (PR A) writes; PR-B's consumer asserts
// it's present before embedding. Missing → malformed branch.
const FRAGMENT_HEADING = "## Memory liveness";

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

function resolveStatusFragmentPath(arg) {
  if (arg) return arg;
  if (process.env.CAIRN_STATUS_FRAGMENT) return process.env.CAIRN_STATUS_FRAGMENT;
  return join(homedir(), ".claude", "cairn", "status-fragment.md");
}

/**
 * Read the Cairn status fragment if present and classify it across the four
 * B7 branches. Pure: no writes; returns a plain object.
 *
 * Returns one of:
 *   { branch: "absent" }                              — file does not exist
 *   { branch: "malformed" }                           — anchor heading missing
 *   { branch: "fresh", body }                         — anchor + within window
 *   { branch: "stale",  body, ageMs }                 — anchor + outside window
 */
export function classifyStatusFragment(fragmentPath, now = Date.now(), windowMs = FRAGMENT_FRESHNESS_MS) {
  let st;
  try {
    st = statSync(fragmentPath);
  } catch {
    return { branch: "absent" };
  }
  let body;
  try {
    body = readFileSync(fragmentPath, "utf8");
  } catch {
    return { branch: "absent" };
  }
  if (!body.includes(FRAGMENT_HEADING)) {
    return { branch: "malformed" };
  }
  const ageMs = now - st.mtimeMs;
  if (ageMs > windowMs) {
    return { branch: "stale", body, ageMs };
  }
  return { branch: "fresh", body };
}

function formatAgeShort(ageMs) {
  if (ageMs == null || ageMs < 0) return "0s";
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

/**
 * Render the memory-liveness section to append to tier-a.md, given a fragment
 * classification. Returns "" for the absent branch (caller emits nothing).
 * Branch-(c) malformed appends a single optional note line so an operator
 * inspecting tier-a.md can tell the difference between "absent" and "Cairn
 * wrote junk" without having to open the fragment file.
 */
export function renderLivenessSection(classification) {
  if (classification.branch === "absent") return "";
  if (classification.branch === "malformed") {
    return "\n_memory-liveness: malformed_\n";
  }
  if (classification.branch === "fresh") {
    return "\n" + classification.body.trimEnd() + "\n";
  }
  // stale — embed body but tag the heading with an age annotation so
  // consumers see at a glance the panel is past its freshness window.
  const ageStr = formatAgeShort(classification.ageMs);
  const annotated = classification.body.replace(
    FRAGMENT_HEADING,
    `${FRAGMENT_HEADING} (stale — ${ageStr} old)`,
  );
  return "\n" + annotated.trimEnd() + "\n";
}

export function refresh({ root, budget = DEFAULT_BUDGET, dryRun = false, statusFragmentPath } = {}) {
  const tierBRoot = join(root, "tier-b");
  const cards = loadCards(tierBRoot);
  const tierA = compact(cards, { budget });

  const fragPath = resolveStatusFragmentPath(statusFragmentPath);
  const classification = classifyStatusFragment(fragPath);
  const livenessSection = renderLivenessSection(classification);
  const finalContent = tierA + livenessSection;

  const outPath = join(root, "tier-a.md");
  if (!dryRun) {
    mkdirSync(root, { recursive: true });
    writeFileSync(outPath, finalContent, "utf8");
  }
  return {
    outPath,
    bytes: Buffer.byteLength(finalContent, "utf8"),
    cardCount: cards.length,
    content: finalContent,
    livenessBranch: classification.branch,
  };
}

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a === "--budget") out.budget = parseInt(argv[++i], 10);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--status-fragment") out.statusFragmentPath = argv[++i];
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("refresh.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot(args.root);
  const res = refresh({
    root,
    budget: args.budget,
    dryRun: args.dryRun,
    statusFragmentPath: args.statusFragmentPath,
  });
  process.stdout.write(`refreshed ${res.outPath} (${res.bytes} bytes, ${res.cardCount} cards, liveness=${res.livenessBranch})\n`);
}

#!/usr/bin/env node
// migrate-out: bundle local tier-b cards into a transport branch on the
// agent-working-memory-content backup repo.
//
// Mental model: a migration is an explicit cross-machine handoff snapshot,
// not a daily push. Migration branches live on the backup repo
// (`migration/<host-id>-<YYYY-MM-DD>` by default) — distinct from `main`
// which the daily content-sync cron owns.
//
// Surface:
//   memory migrate-out [--target-branch <name>] [--include-non-pinned]
//                      [--root PATH] [--clone PATH] [--dry-run] [--verbose]
//
// Default behavior:
//   - Target branch: migration/<host-id>-<YYYY-MM-DD> (auto-derived).
//   - Filter: only `pinned: true` cards (matches the daily cron's filter).
//     `--include-non-pinned` widens to every tier-b card.
//   - NEVER writes to `main` (or `master`). Refusal-class error if
//     --target-branch resolves to a protected name.
//   - Pre-flight: scan all candidate cards for regulated-token matches via
//     scripts/lib/privacy-denylist.mjs. If any match, exit non-zero with
//     `PRIVACY-BLOCK` on stderr — no commit, no push.
//
// Round-trip guarantee: cards are copied byte-for-byte (no YAML re-parse,
// no canonicalization), so AC-7 holds.
//
// Exit codes:
//   0  — success (push, dry-run, or no-op)
//   1  — failure (privacy block, git error, etc.)
//   2  — bad usage / argument error

import {
  readFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  getHostId,
  defaultMigrateBranch,
  isMainBranch,
  listTierBCards,
  isPinned,
} from "./lib/migration-bundle.mjs";
import { findFirstMatch, RULE_SPEC_ALLOWLIST } from "./lib/privacy-denylist.mjs";

const DEFAULT_REMOTE = "https://github.com/ziyilam3999/agent-working-memory-content.git";

// --------------------------------------------------------------------
// CLI parsing.

function parseArgs(argv) {
  const out = { dryRun: false, verbose: false, includeNonPinned: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--include-non-pinned") out.includeNonPinned = true;
    else if (a === "--target-branch") out.targetBranch = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--clone") out.clone = argv[++i];
    else if (a === "--remote") out.remote = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else out.unknownArg = a;
  }
  return out;
}

function usage() {
  return [
    "usage: memory migrate-out [--target-branch NAME] [--include-non-pinned]",
    "                          [--root PATH] [--clone PATH] [--remote URL]",
    "                          [--dry-run] [--verbose]",
    "",
    "Bundle local tier-b cards into a migration branch on the content backup repo.",
    "",
    "  --target-branch NAME    push to NAME instead of migration/<host-id>-<date>",
    "                          (NAME must NOT be 'main' or 'master')",
    "  --include-non-pinned    include unpinned cards too (default: pinned only)",
    "  --root PATH             tier-b root (default: $WORKING_MEMORY_ROOT)",
    "  --clone PATH            local clone path of the content backup repo",
    "  --remote URL            override the content-repo remote URL",
    "  --dry-run               print actions, no writes, no commits",
    "  --verbose               extra debug output to stderr",
    "",
  ].join("\n");
}

// --------------------------------------------------------------------
// Path resolution.

function resolveRoot(arg) {
  if (arg) return arg;
  if (process.env.WORKING_MEMORY_ROOT) return process.env.WORKING_MEMORY_ROOT;
  return join(homedir(), ".claude", "agent-working-memory");
}

function resolveClone(arg) {
  if (arg) return arg;
  if (process.env.MIGRATE_REPO_CLONE) return process.env.MIGRATE_REPO_CLONE;
  if (process.env.CONTENT_REPO_CLONE) return process.env.CONTENT_REPO_CLONE;
  // Migrate uses its own clone path so it doesn't fight with content-sync's
  // clone. Each command can keep its own checkout state.
  return join(homedir(), ".claude", "agent-working-memory", "migrate-repo-clone");
}

function resolveRemote(arg) {
  if (arg) return arg;
  if (process.env.MIGRATE_REPO_REMOTE) return process.env.MIGRATE_REPO_REMOTE;
  if (process.env.CONTENT_REPO_REMOTE) return process.env.CONTENT_REPO_REMOTE;
  return DEFAULT_REMOTE;
}

// --------------------------------------------------------------------
// Git helpers.

function git(cwd, args, opts = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(opts.env || {}) },
  });
}

function ensureClone(cloneRoot, remoteUrl) {
  if (existsSync(join(cloneRoot, ".git"))) return;
  mkdirSync(dirname(cloneRoot), { recursive: true });
  // Clone without specifying a branch — we'll create or check out the
  // target branch ourselves below. This avoids the "branch not found"
  // failure when the migration branch doesn't exist yet on the remote.
  // Force core.autocrlf=false on the clone so byte-level round-trip
  // (AC-7) holds on Windows hosts where the global git config has
  // autocrlf=true. We never edit .md text content here — bytes flow
  // through unmodified — so disabling autocrlf is the safe default.
  execFileSync("git", ["-c", "core.autocrlf=false", "clone", remoteUrl, cloneRoot], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  try {
    execFileSync("git", ["config", "core.autocrlf", "false"], {
      cwd: cloneRoot, stdio: "ignore",
    });
    execFileSync("git", ["config", "core.eol", "lf"], {
      cwd: cloneRoot, stdio: "ignore",
    });
  } catch { /* tolerate — best-effort */ }
}

function configureAuthor(cloneRoot) {
  if (process.env.MIGRATE_AUTHOR_NAME) {
    git(cloneRoot, ["config", "user.name", process.env.MIGRATE_AUTHOR_NAME]);
  }
  if (process.env.MIGRATE_AUTHOR_EMAIL) {
    git(cloneRoot, ["config", "user.email", process.env.MIGRATE_AUTHOR_EMAIL]);
  }
}

function checkoutTargetBranch(cloneRoot, branch) {
  // Try to fetch the branch from origin if it exists already.
  try {
    git(cloneRoot, ["fetch", "origin", branch]);
    git(cloneRoot, ["checkout", "-B", branch, `origin/${branch}`]);
    return;
  } catch {
    // Not yet on remote — create from current HEAD (default branch HEAD
    // after clone). This is the first-push case.
  }
  try {
    git(cloneRoot, ["checkout", "-B", branch]);
  } catch (err) {
    throw new Error(`failed to create branch ${branch}: ${err.message}`);
  }
}

// --------------------------------------------------------------------
// Privacy pre-flight: scan every candidate card for regulated tokens.

export function privacyPreflight(cards) {
  const violations = [];
  for (const card of cards) {
    // Rule-spec allowlist: a tiny set of cards LEGITIMATELY carry the
    // regulated token because they ARE the rule (parent-claude.md
    // privacy spec exemption clause). Skip the scan entirely for those
    // exact paths. Path-pinned — see RULE_SPEC_ALLOWLIST docstring.
    if (RULE_SPEC_ALLOWLIST.has(card.relPath)) continue;
    let text;
    try { text = readFileSync(card.absPath, "utf8"); } catch { continue; }
    const hit = findFirstMatch(text);
    if (hit) violations.push({ relPath: card.relPath, ...hit });
  }
  return violations;
}

// --------------------------------------------------------------------
// Main entry (programmatic).

export async function runMigrateOut(opts = {}) {
  const tierBRoot = join(resolveRoot(opts.root), "tier-b");
  const cloneRoot = resolveClone(opts.clone);
  const remoteUrl = resolveRemote(opts.remote);
  const branch = opts.targetBranch || defaultMigrateBranch();
  const includeNonPinned = !!opts.includeNonPinned;
  const dryRun = !!opts.dryRun;
  const verbose = !!opts.verbose;
  const skipPush = process.env.MIGRATE_SKIP_PUSH === "1" || opts.skipPush === true;

  const log = (msg) => { if (verbose) process.stderr.write(`migrate-out: ${msg}\n`); };

  if (isMainBranch(branch)) {
    return {
      exitCode: 1,
      error: `refusing to push to protected branch '${branch}'. Use a migration/* branch instead.`,
      errClass: "protected-branch",
    };
  }

  // 1. Enumerate tier-b cards on disk.
  const allCards = listTierBCards(tierBRoot);
  const cards = includeNonPinned
    ? allCards
    : allCards.filter((c) => isPinned(c.absPath));

  log(`enumerated ${allCards.length} cards (${cards.length} after filter, includeNonPinned=${includeNonPinned})`);

  // 2. Privacy pre-flight. ALWAYS runs, even in dry-run, so the operator
  //    sees the block immediately rather than discovering it on push.
  const violations = privacyPreflight(cards);
  if (violations.length > 0) {
    const lines = violations.slice(0, 10).map((v) => `  ${v.relPath}: pattern=${v.name} match=${JSON.stringify(v.match)}`);
    const more = violations.length > 10 ? `  ... and ${violations.length - 10} more\n` : "";
    process.stderr.write(
      `PRIVACY-BLOCK migrate-out aborted — ${violations.length} card(s) contain regulated tokens:\n` +
      lines.join("\n") + (lines.length ? "\n" : "") + more,
    );
    return {
      exitCode: 1,
      error: `PRIVACY-BLOCK ${violations.length} regulated-token match(es)`,
      errClass: "privacy-block",
      violations,
    };
  }

  if (dryRun) {
    const out = cards.map((c) => `BUNDLE ${c.relPath}`).join("\n") + (cards.length ? "\n" : "");
    return {
      exitCode: 0,
      branch,
      dryRun: true,
      output: `branch: ${branch}\n${out}`,
      bundled: cards.length,
    };
  }

  // 3. Set up the clone + checkout the target branch.
  try {
    ensureClone(cloneRoot, remoteUrl);
    log(`clone at ${cloneRoot}`);
    configureAuthor(cloneRoot);
    checkoutTargetBranch(cloneRoot, branch);
    log(`checked out branch ${branch}`);
  } catch (err) {
    return { exitCode: 1, error: `clone/checkout failed: ${err.message}`, errClass: "git" };
  }

  // 4. Copy bytes into the worktree's tier-b/ tree.
  // listTierBCards returns relPaths like "topics/<topic>/<id>.md" (relative
  // to the local tier-b root). The backup repo mirrors this under tier-b/,
  // so the destination is <clone>/tier-b/<relPath>.
  const touched = [];
  for (const c of cards) {
    const destRel = join("tier-b", c.relPath);
    const dest = join(cloneRoot, destRel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(c.absPath, dest);
    touched.push(destRel.split(sep).join("/"));
  }

  // 5. Stage explicitly (one path at a time — no `git add .`).
  for (const path of touched) {
    try { git(cloneRoot, ["add", "--", path]); }
    catch (err) {
      return { exitCode: 1, error: `git add ${path} failed: ${err.message}`, errClass: "git" };
    }
  }

  // 6. Detect whether anything is actually staged.
  let hasStaged = true;
  try {
    git(cloneRoot, ["diff", "--cached", "--quiet"]);
    hasStaged = false;
  } catch {
    hasStaged = true;
  }
  if (!hasStaged) {
    log("no delta — nothing to commit");
    return { exitCode: 0, branch, bundled: touched.length, committed: false, pushed: false };
  }

  // 7. Commit + push.
  const subject = `chore(migrate-out): ${cards.length} card(s) from ${getHostId()}`;
  try {
    git(cloneRoot, ["commit", "-m", subject]);
    log(`committed: ${subject}`);
  } catch (err) {
    return { exitCode: 1, error: `git commit failed: ${err.message}`, errClass: "git" };
  }

  let pushed = false;
  if (!skipPush) {
    try {
      git(cloneRoot, ["push", "origin", branch]);
      pushed = true;
      log(`pushed origin/${branch}`);
    } catch (err) {
      return { exitCode: 1, error: `git push failed: ${err.message}`, errClass: "push-failed" };
    }
  }

  return { exitCode: 0, branch, bundled: touched.length, committed: true, pushed, subject };
}

// --------------------------------------------------------------------
// CLI entry.

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (args.unknownArg) {
    process.stderr.write(`migrate-out: unknown arg: ${args.unknownArg}\n${usage()}`);
    return 2;
  }
  const r = await runMigrateOut({
    targetBranch: args.targetBranch,
    includeNonPinned: args.includeNonPinned,
    root: args.root,
    clone: args.clone,
    remote: args.remote,
    dryRun: args.dryRun,
    verbose: args.verbose,
  });
  if (r.dryRun) {
    process.stdout.write(r.output);
    return r.exitCode;
  }
  if (r.exitCode === 0) {
    if (r.committed) {
      process.stdout.write(`migrate-out: ${r.subject} → ${r.branch} (pushed=${r.pushed})\n`);
    } else {
      process.stdout.write(`migrate-out: no delta on ${r.branch}\n`);
    }
  } else {
    if (r.errClass !== "privacy-block") {
      // privacy-block already wrote PRIVACY-BLOCK on stderr in
      // privacyPreflight; don't double-report.
      process.stderr.write(`migrate-out: FAILED class=${r.errClass} ${r.error}\n`);
    }
  }
  return r.exitCode;
}

const invokedAsCli =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("migrate-out.mjs");
if (invokedAsCli) {
  main()
    .then((c) => process.exit(c || 0))
    .catch((e) => {
      process.stderr.write(`migrate-out: unexpected error: ${e.message}\n`);
      process.exit(1);
    });
}

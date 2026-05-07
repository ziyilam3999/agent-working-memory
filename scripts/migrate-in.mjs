#!/usr/bin/env node
// migrate-in: apply a transport branch from the agent-working-memory-content
// backup repo into local tier-b, with a per-file merge strategy.
//
// Surface:
//   memory migrate-in [--from-branch <name>]
//                     [--strategy <prefer-local|prefer-remote|prefer-newer-commit>]
//                     [--root PATH] [--clone PATH] [--remote URL]
//                     [--dry-run] [--verbose]
//
// Default behavior:
//   - From branch: most recent migration/* branch on the backup repo
//     (sorted lexically descending — branch names embed YYYY-MM-DD so
//     lex-desc = chronological-desc).
//   - Strategy: prefer-newer-commit (uses `git log -1 --format=%ct <path>`
//     on each side; locally-untracked cards win — see Plan AC 6b).
//   - Round-trip: bytes are copied via copyFileSync, never re-parsed.
//
// Exit codes:
//   0  — success
//   1  — failure
//   2  — bad usage / argument error

import {
  copyFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join, dirname, sep, relative } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  getFileCommitTime,
  getFileMtimeSeconds,
  resolveStrategy,
} from "./lib/migration-bundle.mjs";

const DEFAULT_REMOTE = "https://github.com/ziyilam3999/agent-working-memory-content.git";
const VALID_STRATEGIES = new Set(["prefer-local", "prefer-remote", "prefer-newer-commit"]);

// --------------------------------------------------------------------
// CLI parsing.

function parseArgs(argv) {
  const out = { dryRun: false, verbose: false, strategy: "prefer-newer-commit" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--from-branch") out.fromBranch = argv[++i];
    else if (a === "--strategy") out.strategy = argv[++i];
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
    "usage: memory migrate-in [--from-branch NAME] [--strategy STRATEGY]",
    "                         [--root PATH] [--clone PATH] [--remote URL]",
    "                         [--dry-run] [--verbose]",
    "",
    "Apply a transport branch into local tier-b with per-file merge strategy.",
    "",
    "  --from-branch NAME      pull from NAME (default: most recent migration/*)",
    "  --strategy STRATEGY     prefer-local | prefer-remote | prefer-newer-commit",
    "                          (default: prefer-newer-commit; untracked-local wins)",
    "  --root PATH             tier-b root (default: $WORKING_MEMORY_ROOT)",
    "  --clone PATH            local clone path of the content backup repo",
    "  --remote URL            override the content-repo remote URL",
    "  --dry-run               print actions, no writes",
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
  // Force core.autocrlf=false on the clone so byte-level round-trip
  // (AC-7) holds on Windows hosts where the global git config has
  // autocrlf=true. Migrate-in only ever copyFileSync's bytes from the
  // checked-out worktree into the local tier-b — it never re-parses or
  // canonicalizes — so disabling autocrlf is the safe default.
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
    // Re-checkout to apply the new line-ending policy to the working tree.
    execFileSync("git", ["checkout", "--", "."], { cwd: cloneRoot, stdio: "ignore" });
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

function listRemoteMigrationBranches(cloneRoot) {
  try {
    const out = git(cloneRoot, ["branch", "-r", "--list", "origin/migration/*"]);
    return out.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^origin\//, ""))
      .sort()
      .reverse(); // lex-desc = date-desc since the slug embeds YYYY-MM-DD
  } catch {
    return [];
  }
}

function checkoutBranch(cloneRoot, branch) {
  // Fetch then checkout to a detached state — we don't need to track or
  // commit; we only read.
  git(cloneRoot, ["fetch", "origin", branch]);
  git(cloneRoot, ["checkout", "-B", branch, `origin/${branch}`]);
}

// --------------------------------------------------------------------
// Tier-b enumeration in either local root or clone.

function listMdFilesUnder(root) {
  const out = []; // { relPath (forward-slash, root-relative), absPath }
  if (!existsSync(root)) return out;
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name.endsWith(".md")) {
        const rel = relative(root, full).split(sep).join("/");
        out.push({ relPath: rel, absPath: full });
      }
    }
  }
  walk(root);
  return out;
}

// --------------------------------------------------------------------
// Decision: per-relPath, where does the winning bytes come from?

// localGitRoot may be null. When non-null, local-ct comes from `git log` on
// that repo (tier-b/ inside a git working tree — the test-harness shape).
// When null, tier-b is plain files (the production shape) and local-ct
// comes from filesystem mtime via getFileMtimeSeconds.
export function planMerge({ localTierBRoot, remoteTierBRoot, localGitRoot, remoteGitDir, strategy }) {
  // Forward-slash relPath under tier-b/ (matches content-sync convention).
  const localFiles = new Map(); // relPath -> absPath
  for (const f of listMdFilesUnder(join(localTierBRoot, "topics"))) {
    localFiles.set(`topics/${f.relPath}`, join(localTierBRoot, "topics", f.relPath.split("/").join(sep)));
  }
  const remoteFiles = new Map();
  for (const f of listMdFilesUnder(join(remoteTierBRoot, "topics"))) {
    remoteFiles.set(`topics/${f.relPath}`, join(remoteTierBRoot, "topics", f.relPath.split("/").join(sep)));
  }

  const allRel = new Set([...localFiles.keys(), ...remoteFiles.keys()]);
  const decisions = []; // { relPath, action: "copy-from-remote" | "keep-local" | "add-from-remote", reason }

  for (const rel of [...allRel].sort()) {
    const onLocal = localFiles.has(rel);
    const onRemote = remoteFiles.has(rel);
    if (onRemote && !onLocal) {
      decisions.push({ relPath: rel, action: "add-from-remote", reason: "local-missing" });
      continue;
    }
    if (onLocal && !onRemote) {
      // Strategy doesn't enter; remote has nothing to say.
      decisions.push({ relPath: rel, action: "keep-local", reason: "remote-missing" });
      continue;
    }
    // Both present — strategy resolves. Pick local-ct lookup based on
    // whether tier-b is inside a git repo: git log when yes, mtime when no.
    let localCt;
    if (localGitRoot) {
      localCt = getFileCommitTime(localGitRoot, join("tier-b", rel).split(sep).join("/"));
    } else {
      localCt = getFileMtimeSeconds(localFiles.get(rel));
    }
    const remoteCt = getFileCommitTime(remoteGitDir, join("tier-b", rel).split(sep).join("/"));
    const winner = resolveStrategy(strategy, localCt, remoteCt);
    if (winner === "remote") {
      decisions.push({
        relPath: rel,
        action: "copy-from-remote",
        reason: `strategy=${strategy} local-ct=${localCt} remote-ct=${remoteCt}`,
      });
    } else {
      decisions.push({
        relPath: rel,
        action: "keep-local",
        reason: `strategy=${strategy} local-ct=${localCt} remote-ct=${remoteCt}`,
      });
    }
  }

  return { decisions, localFiles, remoteFiles };
}

// --------------------------------------------------------------------
// Main entry (programmatic).

export async function runMigrateIn(opts = {}) {
  const tierBRoot = join(resolveRoot(opts.root), "tier-b");
  const cloneRoot = resolveClone(opts.clone);
  const remoteUrl = resolveRemote(opts.remote);
  const strategy = opts.strategy || "prefer-newer-commit";
  const dryRun = !!opts.dryRun;
  const verbose = !!opts.verbose;

  const log = (msg) => { if (verbose) process.stderr.write(`migrate-in: ${msg}\n`); };

  if (!VALID_STRATEGIES.has(strategy)) {
    return { exitCode: 2, error: `unknown strategy: ${strategy}`, errClass: "bad-arg" };
  }

  // 1. Set up the clone.
  try {
    ensureClone(cloneRoot, remoteUrl);
    log(`clone at ${cloneRoot}`);
    configureAuthor(cloneRoot);
  } catch (err) {
    return { exitCode: 1, error: `clone failed: ${err.message}`, errClass: "git" };
  }

  // 2. Pick the from-branch.
  let fromBranch = opts.fromBranch;
  if (!fromBranch) {
    try { git(cloneRoot, ["fetch", "origin"]); } catch { /* tolerate, listRemoteMigrationBranches is best-effort */ }
    const candidates = listRemoteMigrationBranches(cloneRoot);
    if (candidates.length === 0) {
      return {
        exitCode: 1,
        error: "no migration/* branches found on remote; pass --from-branch explicitly",
        errClass: "no-migration-branch",
      };
    }
    fromBranch = candidates[0];
    log(`auto-selected from-branch: ${fromBranch}`);
  }

  // 3. Check out the from-branch.
  try {
    checkoutBranch(cloneRoot, fromBranch);
    log(`checked out ${fromBranch}`);
  } catch (err) {
    return { exitCode: 1, error: `checkout ${fromBranch} failed: ${err.message}`, errClass: "git" };
  }

  // 4. Compute the merge plan.
  // localGitRoot is null when tier-b is plain files (production shape: the
  // user's home dir is not a git repo). planMerge then uses filesystem mtime
  // for local-ct instead of `git log`. Pairs with the utimesSync stamp in
  // step 5: cards copied from a remote commit at epoch T have mtime = T, so
  // round-trip migrate-in calls see honest comparisons rather than the
  // pre-fix "always Infinity → always wins" silent-degenerate.
  const localGitRoot = findLocalGitRoot(tierBRoot);
  const remoteGitDir = cloneRoot;
  const remoteTierBRoot = join(cloneRoot, "tier-b");

  const { decisions } = planMerge({
    localTierBRoot: tierBRoot,
    remoteTierBRoot,
    localGitRoot,
    remoteGitDir,
    strategy,
  });

  if (dryRun) {
    const lines = decisions.map((d) => `${d.action} ${d.relPath} (${d.reason})`);
    return {
      exitCode: 0,
      dryRun: true,
      output: `from-branch: ${fromBranch}\nstrategy: ${strategy}\n` + lines.join("\n") + (lines.length ? "\n" : ""),
      decisions,
      fromBranch,
    };
  }

  // 5. Execute the plan.
  let written = 0;
  for (const d of decisions) {
    if (d.action === "keep-local") continue;
    const dest = join(tierBRoot, d.relPath.split("/").join(sep));
    const srcRelOnRemote = d.relPath.split("/").join(sep);
    const src = join(remoteTierBRoot, srcRelOnRemote);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    // Stamp dest mtime to the source commit's committed-date so subsequent
    // migrate-in calls see honest local-ct values via getFileMtimeSeconds.
    // If the lookup fails (no commit history for the file on the remote
    // branch), fall back to copy-time mtime — matches the pre-fix behavior
    // for that edge case.
    const remoteCt = getFileCommitTime(remoteGitDir, "tier-b/" + d.relPath);
    if (Number.isFinite(remoteCt)) {
      try { utimesSync(dest, remoteCt, remoteCt); } catch { /* tolerate stamp failure; copy still succeeded */ }
    }
    written += 1;
  }

  return { exitCode: 0, fromBranch, strategy, decisions, written };
}

function findLocalGitRoot(startDir) {
  // Walk upward from startDir; if any ancestor has .git, return it. This
  // lets the test harness point migrate-in at a non-git tier-b root and
  // still get the "no commit info → Infinity" fallback (the test relies on
  // it for the untracked-card AC 6b case).
  let cur = startDir;
  while (cur) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
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
    process.stderr.write(`migrate-in: unknown arg: ${args.unknownArg}\n${usage()}`);
    return 2;
  }
  const r = await runMigrateIn({
    fromBranch: args.fromBranch,
    strategy: args.strategy,
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
    process.stdout.write(`migrate-in: from=${r.fromBranch} strategy=${r.strategy} wrote=${r.written}\n`);
  } else {
    process.stderr.write(`migrate-in: FAILED class=${r.errClass} ${r.error}\n`);
  }
  return r.exitCode;
}

const invokedAsCli =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("migrate-in.mjs");
if (invokedAsCli) {
  main()
    .then((c) => process.exit(c || 0))
    .catch((e) => {
      process.stderr.write(`migrate-in: unexpected error: ${e.message}\n`);
      process.exit(1);
    });
}

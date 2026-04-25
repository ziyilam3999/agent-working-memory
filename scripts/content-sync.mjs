#!/usr/bin/env node
// Content-sync: keep pinned tier-b cards in lockstep with the GitHub backup
// repo `agent-working-memory-content`. One-way push only (local → backup).
//
// Surfaces:
//   - dry-run: print deterministic per-card action lines, exit 0, no commits.
//   - full run: stage diffs, commit, push to origin. Exits non-zero on push
//     failure and writes a single-line failure record (last-error-only) to
//     <clone>/.last-sync-error.log.
//   - npm run sync: same logic as the cron path (B5).
//
// Determinism contract:
//   - Action lines are sorted by relative path (forward-slash separators).
//   - Action prefixes: ADD, UPDATE, DELETE, SKIP-FILTER (with reason token).
//   - Commit subject prefix is fixed ("chore(content-sync): ...") so
//     downstream tooling can grep without depending on the sync's body.
//
// Idempotency:
//   - UPDATE is detected via SHA-256 of the source vs. destination bytes.
//     Equal bytes → SKIP (no action line emitted; the file is already in
//     sync). This keeps a second consecutive run with no local delta from
//     producing a fresh commit (B2).
//
// Test seams (env vars; production omits all of them):
//   WORKING_MEMORY_ROOT          — root of tier-b (default $HOME/.claude/agent-working-memory)
//   CONTENT_REPO_CLONE           — local clone path of the content repo
//   CONTENT_REPO_REMOTE          — git remote URL override (B10 — exercises
//                                  the failure path in tests)
//   CONTENT_REPO_BRANCH          — target branch (default "main")
//   CONTENT_SYNC_SKIP_PUSH       — "1" to skip push (used by the e2e test
//                                  when no remote is reachable)
//   CONTENT_SYNC_AUTHOR_NAME     — git author override
//   CONTENT_SYNC_AUTHOR_EMAIL    — git author override
//
// Flags:
//   --dry-run            — print actions, no writes, no commits
//   --verbose            — emit extra debug lines on stderr
//   --root PATH          — override WORKING_MEMORY_ROOT for one run
//   --clone PATH         — override CONTENT_REPO_CLONE for one run
//
// Exit codes:
//   0  — success (dry-run, no-op, or successful push)
//   1  — sync failure (write failure record before exiting)
//   2  — bad usage / argument error

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseCard } from "../src/card-shape.mjs";
import { shouldInclude } from "./lib/content-filter.mjs";

const COMMIT_SUBJECT_PREFIX = "chore(content-sync): sync pinned cards";
const FAILURE_RECORD_NAME = ".last-sync-error.log";
const DEFAULT_BRANCH = "main";
const DEFAULT_RETRY_BUDGET = 3;

// ---------------------------------------------------------------------------
// CLI parsing.

function parseArgs(argv) {
  const out = { dryRun: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--clone") out.clone = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      out.unknownArg = a;
    }
  }
  return out;
}

function usage() {
  return [
    "usage: content-sync [--dry-run] [--verbose] [--root PATH] [--clone PATH]",
    "  --dry-run    print actions, no writes, no commits",
    "  --verbose    emit extra debug lines on stderr",
    "  --root PATH  override WORKING_MEMORY_ROOT for one run",
    "  --clone PATH override CONTENT_REPO_CLONE for one run",
    "",
    "env:",
    "  WORKING_MEMORY_ROOT         tier-b root",
    "  CONTENT_REPO_CLONE          local clone of the content repo",
    "  CONTENT_REPO_REMOTE         remote URL override",
    "  CONTENT_REPO_BRANCH         target branch (default main)",
    "  CONTENT_SYNC_SKIP_PUSH=1    skip the push step (test seam)",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Path resolution.

function resolveRoot(arg) {
  if (arg) return arg;
  if (process.env.WORKING_MEMORY_ROOT) return process.env.WORKING_MEMORY_ROOT;
  return join(homedir(), ".claude", "agent-working-memory");
}

function resolveClone(arg) {
  if (arg) return arg;
  if (process.env.CONTENT_REPO_CLONE) return process.env.CONTENT_REPO_CLONE;
  return join(homedir(), ".claude", "agent-working-memory", "content-repo-clone");
}

// ---------------------------------------------------------------------------
// Sources: enumerate tier-b cards relative to tier-b root, applying the
// content-filter predicate.

function listLocalSources(tierBRoot) {
  const out = []; // { relPath (forward-slash, tier-b-relative), absPath, included, reason }
  const topicsDir = join(tierBRoot, "topics");
  if (!existsSync(topicsDir)) return out;

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const rel = relative(tierBRoot, full).split(sep).join("/");
        let parsed = null;
        if (rel.endsWith(".md")) {
          try {
            const text = readFileSync(full, "utf8");
            parsed = parseCard(text);
          } catch {
            parsed = { ok: false, reason: "read-error" };
          }
        }
        const decision = shouldInclude(rel, parsed);
        out.push({
          relPath: rel,
          absPath: full,
          included: decision.included,
          reason: decision.reason,
        });
      }
    }
  }
  walk(topicsDir);
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Destinations: enumerate tracked card files in the content-repo clone so we
// can compute DELETE actions for cards that disappeared locally.

function listClonedDests(cloneRoot) {
  const out = new Map(); // relPath → absPath
  const tierBDir = join(cloneRoot, "tier-b");
  if (!existsSync(tierBDir)) return out;

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name.endsWith(".md")) {
        const rel = relative(tierBDir, full).split(sep).join("/");
        out.set(rel, full);
      }
    }
  }
  walk(tierBDir);
  return out;
}

// ---------------------------------------------------------------------------
// Hash-based edit detection.

function fileHash(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plan: compute the set of actions from local + cloned state. Pure-ish (only
// reads files for hash compare; no writes). Returns deterministic-ordered
// actions.

export function computePlan(tierBRoot, cloneRoot) {
  const sources = listLocalSources(tierBRoot);
  const dests = listClonedDests(cloneRoot);

  const actions = []; // { kind, relPath, reason? }

  // Forward direction: source → dest.
  for (const src of sources) {
    if (!src.included) {
      actions.push({ kind: "SKIP-FILTER", relPath: src.relPath, reason: src.reason });
      continue;
    }
    const destAbs = join(cloneRoot, "tier-b", src.relPath);
    if (!dests.has(src.relPath)) {
      actions.push({ kind: "ADD", relPath: src.relPath });
    } else {
      const sh = fileHash(src.absPath);
      const dh = fileHash(destAbs);
      if (sh !== null && dh !== null && sh !== dh) {
        actions.push({ kind: "UPDATE", relPath: src.relPath });
      }
      // equal hashes → no action (idempotent path).
    }
  }

  // Reverse direction: dest → source. Anything in the clone that has no
  // corresponding *included* source is a DELETE candidate.
  const includedRels = new Set(sources.filter((s) => s.included).map((s) => s.relPath));
  for (const rel of [...dests.keys()].sort()) {
    if (!includedRels.has(rel)) {
      actions.push({ kind: "DELETE", relPath: rel });
    }
  }

  // Final sort: by (relPath, kind) for stable cross-run output. ADD/UPDATE/
  // DELETE appear interleaved with SKIP-FILTER lines, but the ordering is
  // deterministic.
  actions.sort((a, b) => {
    if (a.relPath !== b.relPath) return a.relPath < b.relPath ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
  return actions;
}

// ---------------------------------------------------------------------------
// Apply plan to the local clone working tree. Returns the list of touched
// rel-paths (so the caller can `git add` them explicitly — never `git add -A`).

function applyPlan(actions, tierBRoot, cloneRoot, opts) {
  const touched = [];
  for (const a of actions) {
    if (a.kind === "SKIP-FILTER") continue;
    const destAbs = join(cloneRoot, "tier-b", a.relPath);
    if (a.kind === "ADD" || a.kind === "UPDATE") {
      const srcAbs = join(tierBRoot, a.relPath);
      mkdirSync(dirname(destAbs), { recursive: true });
      copyFileSync(srcAbs, destAbs);
      touched.push(join("tier-b", a.relPath).split(sep).join("/"));
    } else if (a.kind === "DELETE") {
      try { rmSync(destAbs, { force: true }); } catch { /* tolerate */ }
      touched.push(join("tier-b", a.relPath).split(sep).join("/"));
    }
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Git ops on the clone. Each call shells out with execFileSync so a non-zero
// exit propagates up as a thrown Error (caught by main()).

function git(cloneRoot, args, opts = {}) {
  return execFileSync("git", args, {
    cwd: cloneRoot,
    encoding: "utf8",
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(opts.env || {}) },
  });
}

function ensureClone(cloneRoot, remoteUrl, branch) {
  if (existsSync(join(cloneRoot, ".git"))) return;
  mkdirSync(dirname(cloneRoot), { recursive: true });
  execFileSync("git", ["clone", "--branch", branch, remoteUrl, cloneRoot], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function pullRebaseWithRetry(cloneRoot, branch, budget, log) {
  let lastErr = null;
  for (let attempt = 1; attempt <= budget; attempt++) {
    try {
      git(cloneRoot, ["pull", "--rebase", "origin", branch]);
      return;
    } catch (err) {
      lastErr = err;
      log(`pull --rebase attempt ${attempt}/${budget} failed: ${err.message?.split("\n")[0]}`);
    }
  }
  throw lastErr || new Error("pull --rebase failed after retries");
}

// ---------------------------------------------------------------------------
// Failure record: single-line, last-error-only, overwritten each run.

function writeFailureRecord(cloneRoot, errClass, message) {
  try {
    mkdirSync(cloneRoot, { recursive: true });
  } catch { /* tolerate */ }
  const ts = new Date().toISOString();
  const line = `${ts} class=${errClass} message=${message.replace(/\s+/g, " ").slice(0, 500)}\n`;
  try {
    writeFileSync(join(cloneRoot, FAILURE_RECORD_NAME), line, "utf8");
  } catch { /* last-resort silent — we're already in failure path */ }
}

function clearFailureRecord(cloneRoot) {
  try {
    const p = join(cloneRoot, FAILURE_RECORD_NAME);
    if (existsSync(p)) rmSync(p, { force: true });
  } catch { /* tolerate */ }
}

// ---------------------------------------------------------------------------
// Render dry-run output. One line per action; SKIP-FILTER carries reason.

function renderDryRun(actions) {
  const lines = [];
  for (const a of actions) {
    if (a.kind === "SKIP-FILTER") {
      lines.push(`SKIP-FILTER ${a.relPath} reason=${a.reason}`);
    } else {
      lines.push(`${a.kind} ${a.relPath}`);
    }
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

// ---------------------------------------------------------------------------
// Main programmatic entry. Returns { exitCode, actions, touched, ... }.

export async function runSync(opts = {}) {
  const tierBRootArg = opts.root ? join(opts.root, "tier-b") : null;
  const tierBRoot = tierBRootArg || join(resolveRoot(), "tier-b");
  const cloneRoot = resolveClone(opts.clone);
  const remoteUrl =
    opts.remote ||
    process.env.CONTENT_REPO_REMOTE ||
    "https://github.com/ziyilam3999/agent-working-memory-content.git";
  const branch = process.env.CONTENT_REPO_BRANCH || DEFAULT_BRANCH;
  const skipPush = process.env.CONTENT_SYNC_SKIP_PUSH === "1" || opts.skipPush === true;
  const retryBudget = opts.retryBudget || DEFAULT_RETRY_BUDGET;
  const verbose = opts.verbose === true;

  const log = (msg) => {
    if (verbose) process.stderr.write(`content-sync: ${msg}\n`);
  };

  if (opts.dryRun) {
    const actions = computePlan(tierBRoot, cloneRoot);
    return { exitCode: 0, actions, dryRun: true, output: renderDryRun(actions) };
  }

  // Real run: ensure clone exists, pull, apply, commit, push.
  try {
    ensureClone(cloneRoot, remoteUrl, branch);
    log(`clone at ${cloneRoot} (branch ${branch})`);

    // Configure local author so commits don't depend on global git config.
    if (process.env.CONTENT_SYNC_AUTHOR_NAME) {
      git(cloneRoot, ["config", "user.name", process.env.CONTENT_SYNC_AUTHOR_NAME]);
    }
    if (process.env.CONTENT_SYNC_AUTHOR_EMAIL) {
      git(cloneRoot, ["config", "user.email", process.env.CONTENT_SYNC_AUTHOR_EMAIL]);
    }

    if (!skipPush) {
      pullRebaseWithRetry(cloneRoot, branch, retryBudget, log);
    }

    const actions = computePlan(tierBRoot, cloneRoot);
    const realActions = actions.filter((a) => a.kind !== "SKIP-FILTER");
    const touched = applyPlan(actions, tierBRoot, cloneRoot, opts);

    if (touched.length === 0) {
      log("no delta — idempotent no-op");
      clearFailureRecord(cloneRoot);
      return { exitCode: 0, actions, touched, committed: false, pushed: false };
    }

    // Stage explicitly — never `git add -A` or `.`.
    for (const path of touched) {
      git(cloneRoot, ["add", "--", path]);
    }

    // Detect whether anything is actually staged (e.g. a DELETE on a path
    // that didn't exist could leave us with nothing to commit).
    let hasStaged = true;
    try {
      git(cloneRoot, ["diff", "--cached", "--quiet"]);
      hasStaged = false;
    } catch {
      hasStaged = true;
    }
    if (!hasStaged) {
      log("staged set is empty — idempotent no-op");
      clearFailureRecord(cloneRoot);
      return { exitCode: 0, actions, touched, committed: false, pushed: false };
    }

    const subject = `${COMMIT_SUBJECT_PREFIX} (${realActions.length} action${realActions.length === 1 ? "" : "s"})`;
    git(cloneRoot, ["commit", "-m", subject]);
    log(`committed: ${subject}`);

    let pushed = false;
    if (!skipPush) {
      git(cloneRoot, ["push", "origin", branch]);
      pushed = true;
      log(`pushed to origin/${branch}`);
    }

    clearFailureRecord(cloneRoot);
    return { exitCode: 0, actions, touched, committed: true, pushed, subject };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    const errClass = classifyError(err);
    writeFailureRecord(cloneRoot, errClass, msg);
    return { exitCode: 1, error: msg, errClass };
  }
}

function classifyError(err) {
  const msg = ((err && err.message) || "").toLowerCase();
  if (msg.includes("could not resolve host") || msg.includes("network")) return "network";
  if (msg.includes("authentication") || msg.includes("permission denied")) return "auth";
  if (msg.includes("non-fast-forward") || msg.includes("rejected")) return "push-rejected";
  if (msg.includes("pull --rebase")) return "rebase-failed";
  return "git";
}

// ---------------------------------------------------------------------------
// CLI entry.

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (args.unknownArg) {
    process.stderr.write(`content-sync: unknown arg: ${args.unknownArg}\n${usage()}`);
    return 2;
  }
  const result = await runSync({
    dryRun: args.dryRun,
    verbose: args.verbose,
    root: args.root,
    clone: args.clone,
  });
  if (result.dryRun) {
    process.stdout.write(result.output);
    return result.exitCode;
  }
  if (result.exitCode === 0) {
    if (result.committed) {
      process.stdout.write(`content-sync: ${result.subject}\n`);
    } else {
      process.stdout.write("content-sync: no delta\n");
    }
  } else {
    process.stderr.write(`content-sync: FAILED class=${result.errClass} ${result.error}\n`);
  }
  return result.exitCode;
}

const invokedAsCli =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("content-sync.mjs");
if (invokedAsCli) {
  main()
    .then((c) => process.exit(c || 0))
    .catch((e) => {
      process.stderr.write(`content-sync: unexpected error: ${e.message}\n`);
      process.exit(1);
    });
}

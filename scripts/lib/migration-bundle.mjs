// Migration-bundle: shared helpers for `memory migrate-out` and
// `memory migrate-in`.
//
// Responsibilities:
//   - Host-id detection (used in default branch name like
//     `migration/<host-id>-<YYYY-MM-DD>`).
//   - Default branch name derivation.
//   - Per-file commit-time lookup (`git log -1 --format=%ct <path>`).
//   - Strategy resolution for migrate-in (prefer-local / prefer-remote /
//     prefer-newer-commit) — including the untracked-card-as-Infinity rule
//     that the plan calls out (AC 6b).
//   - Tier-b enumeration (paths only — byte copy is the caller's job to
//     preserve round-trip byte equality, AC-7).
//
// Deliberately minimal. No git side effects in this module — callers
// (migrate-out.mjs / migrate-in.mjs) own the commit/push/checkout cycle
// against a worktree of the content backup repo.

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

// --------------------------------------------------------------------
// Host-id derivation.
//
// Default form: <os-family>-<sanitized-hostname>-<short-suffix>.
//
// The richest existing precedent (windows-ansonyoga-914b) uses the last 4
// hex of `Win32_ComputerSystemProduct.UUID` for the suffix. That's
// Windows-only and requires a privileged WMI call; here we fall back to
// the first 4 hex of a sha256 over (os-family + hostname) so the slug is
// host-stable without needing platform-specific probes.

function osFamily() {
  const p = process.platform;
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  if (p === "linux") return "linux";
  return p;
}

function sanitizeHostname(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32) || "unknown";
}

function shortSuffix(seed) {
  // Tiny non-cryptographic-quality hash is fine: this is for slug
  // disambiguation only, never for security. Keep dependency-free.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0).toString(16) + "0000").slice(0, 4);
}

export function getHostId(opts = {}) {
  const override = opts.override || process.env.MEMORY_HOST_ID;
  if (override) return override;
  const fam = osFamily();
  const host = sanitizeHostname(opts.hostname || hostname());
  const suffix = shortSuffix(`${fam}|${host}`);
  return `${fam}-${host}-${suffix}`;
}

// --------------------------------------------------------------------
// Branch name derivation.

function todayUtcDate() {
  const now = new Date();
  // YYYY-MM-DD form, UTC.
  return now.toISOString().slice(0, 10);
}

export function defaultMigrateBranch({ hostId, date } = {}) {
  const id = hostId || getHostId();
  const d = date || todayUtcDate();
  return `migration/${id}-${d}`;
}

export function isMainBranch(name) {
  return name === "main" || name === "master";
}

// --------------------------------------------------------------------
// Tier-b enumeration.
//
// Returns relPath strings (forward-slash, tier-b-relative — same shape as
// content-sync.mjs uses). The caller decides whether to filter by `pinned`
// or include everything.

export function listTierBCards(tierBRoot) {
  const out = [];
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
      else if (st.isFile() && name.endsWith(".md")) {
        const rel = relative(tierBRoot, full).split(sep).join("/");
        out.push({ relPath: rel, absPath: full });
      }
    }
  }
  walk(topicsDir);
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

// --------------------------------------------------------------------
// Per-file commit time lookup.
//
// Returns a Number (Unix epoch seconds), or Infinity for "no commit" (the
// path is untracked or has no commit history in the repo at `gitDir`).
//
// Why Infinity? AC 6b requires that a locally-untracked card always wins
// over a remote-tracked one under prefer-newer-commit. parseInt("") is
// NaN, and NaN comparisons silently return false — yielding wrong-side
// wins. Treating empty as Infinity makes "untracked = freshest" explicit
// and rules out the silent-overwrite path. See plan §Risks.

export function getFileCommitTime(gitDir, relPath) {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%ct", "--", relPath],
      { cwd: gitDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!out) return Infinity;
    const n = Number.parseInt(out, 10);
    if (!Number.isFinite(n)) return Infinity;
    return n;
  } catch {
    // Not a git dir, or git missing — treat as "no commit info" → Infinity
    // (preserves the untracked-wins semantic for in-repo-but-untracked cards).
    return Infinity;
  }
}

// Filesystem-mtime fallback for runtime tier-b roots that are NOT inside a
// git repo (the production shape: tier-b lives as plain files under the
// user's working-memory home, with no .git ancestry). Returns the file's
// mtime in epoch seconds, or Infinity on stat error (preserves the
// untracked-wins safety net for genuinely-missing files — which shouldn't
// happen in planMerge since it only enumerates existing files, but guards
// against a race between enumerate and lookup).
//
// Pairs with the utimesSync stamp in runMigrateIn's copy step: cards copied
// from a remote commit at epoch T have mtime = T, so subsequent migrate-ins
// see honest local-ct values instead of always-Infinity.
export function getFileMtimeSeconds(absPath) {
  try {
    return Math.floor(statSync(absPath).mtimeMs / 1000);
  } catch {
    return Infinity;
  }
}

// --------------------------------------------------------------------
// Strategy resolution for migrate-in conflict cases.
//
// localCommitTime / remoteCommitTime are Numbers (Infinity for untracked).
// Returns "local" | "remote" — caller copies bytes accordingly.

export function resolveStrategy(strategy, localCommitTime, remoteCommitTime) {
  if (strategy === "prefer-local") return "local";
  if (strategy === "prefer-remote") return "remote";
  if (strategy === "prefer-newer-commit") {
    // Both Infinity is degenerate (both untracked). Default: prefer-local
    // — operator's freshest edit wins, matches the Phase-0-like semantic.
    if (localCommitTime === Infinity && remoteCommitTime === Infinity) return "local";
    // Standard case: bigger number = newer commit = wins.
    return localCommitTime >= remoteCommitTime ? "local" : "remote";
  }
  throw new Error(`unknown strategy: ${strategy}`);
}

// --------------------------------------------------------------------
// Pinned filter (parses front matter; doesn't re-emit).
//
// Returns true if `pinned: true` in the card's frontmatter. False on any
// parse failure, missing field, or non-true value. Matches existing
// content-filter behavior so default migrate-out filtering is consistent.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export function isPinned(absPath) {
  let text;
  try { text = readFileSync(absPath, "utf8"); } catch { return false; }
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return false;
  const lines = m[1].split(/\r?\n/);
  for (const line of lines) {
    const mm = /^pinned\s*:\s*(true|false)\s*$/i.exec(line);
    if (mm) return mm[1].toLowerCase() === "true";
  }
  return false;
}

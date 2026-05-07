#!/usr/bin/env node
// /ship Stage 5.6 privacy-denylist gate.
//
// Mechanically blocks any /ship merge whose surfaces (PR body, PR title,
// commit messages, branch name, diff content) contain a regulated-token
// match under DENYLIST_PATTERNS from lib/privacy-denylist.mjs.
//
// This module exports `runGate(opts)` for unit tests AND has a CLI entry
// that /ship Stage 5.6 invokes. The split keeps the gate testable without
// spinning up `gh` / `git` against a real PR.
//
// See AC-1 through AC-9 in
// .ai-workspace/plans/2026-05-06-ship-adopts-privacy-denylist.md for the
// behavioural contract.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { findFirstMatch } from './privacy-denylist.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// AC-5: rule-spec allowlist — diff-content surface only. File-path globs
// here exempt the diff-content surface only; the other 4 surfaces (PR
// body, title, commit messages, branch) are gated unconditionally.
//
// Glob shapes are simple — minimatch is overkill for 6 paths. We compile
// each into a RegExp and test against the file path string.
const ALLOWLIST_GLOBS = Object.freeze([
  'parent-claude.md',
  '**/feedback_no_employer_mention.md',
  'lib/privacy-denylist.mjs',
  'lib/privacy-denylist.provenance.json',
  'scripts/lib/privacy-denylist.mjs',
  'tests/ship/privacy-denylist-gate.test.mjs',
  'tests/ship/privacy-denylist-gate-allowlist.test.mjs',
  'tests/privacy-denylist-gate.test.mjs',
  'tests/privacy-denylist-gate-allowlist.test.mjs',
]);

function globToRegExp(glob) {
  // Translate a small subset of glob to RegExp:
  //   **    -> .*
  //   *     -> [^/]*
  //   .     -> \.
  // Anchored at start and end.
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
    } else if (c === '*') {
      re += '[^/]*';
      i += 1;
    } else if (c === '.') {
      re += '\\.';
      i += 1;
    } else if (/[a-zA-Z0-9_\-/]/.test(c)) {
      re += c;
      i += 1;
    } else {
      // Be conservative — escape any unexpected metachar.
      re += '\\' + c;
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

const ALLOWLIST_REGEXES = ALLOWLIST_GLOBS.map(globToRegExp);

export function isAllowlistedPath(filePath) {
  return ALLOWLIST_REGEXES.some(rx => rx.test(filePath));
}

// AC-1: pinned abort message format. Composed by the gate; printed by the
// caller (SKILL.md prints to stderr; CLI entry below also prints).
export function formatAbortMessage({ patternName, surface }) {
  return [
    `Merge blocked: PR surface contains regulated token`,
    `(pattern: ${patternName}, surface: ${surface}).`,
    `See parent-claude.md "Privacy & Employer-Brand Hygiene" section`,
    `for substitute vocabulary.`,
    ``,
    `To override (with audit trail), add the following line to PR body via`,
    `\`gh pr edit {pr-number} --body\`:`,
    `  privacy-gate-override: <reason>`,
    `Override is logged to ~/.claude/.rule-12-overrides.log`,
    `with PRIVACY-GATE-* decision token.`,
  ].join('\n');
}

// Match override line, requiring non-empty reason after the colon.
// AC-9 distinguishes a well-formed override (passed-with-override) from
// a malformed attempt (aborted-override-missing). We detect the SHAPE
// liberally first, then validate the reason.
const OVERRIDE_LINE_RE = /^[ \t]*privacy-gate-override:[ \t]*(.*)$/m;

export function parseOverride(prBody) {
  if (typeof prBody !== 'string') return { present: false };
  const m = OVERRIDE_LINE_RE.exec(prBody);
  if (!m) return { present: false };
  const reason = (m[1] || '').trim();
  if (reason.length === 0) {
    return { present: true, reason: null, malformed: true };
  }
  return { present: true, reason, malformed: false };
}

// AC-4 hard-block: sha256(lib/privacy-denylist.mjs) === provenance.sha256.
// Returns null on success or a string error reason on mismatch / read failure.
export function verifyVendorIntegrity(repoRoot = REPO_ROOT) {
  const modulePath = join(repoRoot, 'lib', 'privacy-denylist.mjs');
  const provPath = join(repoRoot, 'lib', 'privacy-denylist.provenance.json');
  if (!existsSync(modulePath)) {
    return `vendored module missing at ${modulePath}`;
  }
  if (!existsSync(provPath)) {
    return `provenance file missing at ${provPath}`;
  }
  let bytes, provJson;
  try {
    bytes = readFileSync(modulePath);
  } catch (e) {
    return `failed to read vendored module: ${e.message}`;
  }
  try {
    provJson = JSON.parse(readFileSync(provPath, 'utf8'));
  } catch (e) {
    return `failed to parse provenance.json: ${e.message}`;
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== provJson.sha256) {
    return `sha256 mismatch: actual=${actual}, expected=${provJson.sha256}`;
  }
  return null;
}

// Soft warn (NOT block) when vendored_at is more than N days old.
// Returns { stale: boolean, ageDays: number, vendoredAt: string }.
export function checkVendorFreshness(repoRoot = REPO_ROOT, maxAgeDays = 30, now = Date.now()) {
  const provPath = join(repoRoot, 'lib', 'privacy-denylist.provenance.json');
  if (!existsSync(provPath)) {
    return { stale: false, ageDays: 0, vendoredAt: null };
  }
  let prov;
  try {
    prov = JSON.parse(readFileSync(provPath, 'utf8'));
  } catch {
    return { stale: false, ageDays: 0, vendoredAt: null };
  }
  const vAt = Date.parse(prov.vendored_at);
  if (!Number.isFinite(vAt)) return { stale: false, ageDays: 0, vendoredAt: prov.vendored_at };
  const ageDays = Math.floor((now - vAt) / (1000 * 60 * 60 * 24));
  return { stale: ageDays > maxAgeDays, ageDays, vendoredAt: prov.vendored_at };
}

// Core gate logic. Pure: no I/O. Inputs are surface contents + diff file
// list; outputs are sentinel + optional abort message + match metadata.
//
// Inputs:
//   prBody           string
//   prTitle          string
//   commitMessages   Array<{sha?: string, message: string}>
//   branchName       string
//   diffNameOnly     Array<string>           // file paths from gh pr diff --name-only
//   diffContents     Array<{path: string, content: string}>  // ALL files, including allowlisted
//
// Returns:
//   { sentinel, match?, surface?, abortMessage?, override? }
export function runGate({
  prBody = '',
  prTitle = '',
  commitMessages = [],
  branchName = '',
  diffNameOnly = [],
  diffContents = [],
}) {
  const override = parseOverride(prBody);

  // Helper: attempt to find a match on a labelled surface.
  // Returns { hit: false } or { hit: true, match, name }.
  const scan = (text) => {
    const m = findFirstMatch(text);
    if (!m) return { hit: false };
    return { hit: true, name: m.name, match: m.match };
  };

  // Surface 1: PR body. Note: if the body itself contains a regulated
  // token, we still detect it — overrides cover the squash-merge body
  // carve-out, NOT a PR body that leaks the token outright. The override
  // line is operator-supplied metadata, not a license to leak.
  const bodyHit = scan(prBody);
  if (bodyHit.hit) {
    return decide('PR body', bodyHit, override);
  }

  // Surface 2: PR title.
  const titleHit = scan(prTitle);
  if (titleHit.hit) {
    return decide('PR title', titleHit, override);
  }

  // Surface 3: individual commit messages on master..HEAD.
  for (const c of commitMessages) {
    const h = scan(c.message);
    if (h.hit) {
      const surfaceLabel = c.sha
        ? `commit ${String(c.sha).slice(0, 12)}`
        : 'commit';
      return decide(surfaceLabel, h, override);
    }
  }

  // Surface 4: branch name.
  const branchHit = scan(branchName);
  if (branchHit.hit) {
    return decide('branch', branchHit, override);
  }

  // Surface 5: diff content — but only for non-allowlisted files.
  // diffContents is keyed by file path; we honour AC-5 here.
  let diffHadNonAllowlistedFile = false;
  for (const f of diffContents) {
    if (isAllowlistedPath(f.path)) continue;
    diffHadNonAllowlistedFile = true;
    const h = scan(f.content);
    if (h.hit) {
      return decide(`diff (${f.path})`, h, override);
    }
  }

  // No matches anywhere. Determine pass vs skipped-allowlisted.
  // skipped-allowlisted requires: every diff file was allowlisted AND all
  // 4 non-file surfaces were clean (which we've already verified above).
  const allDiffAllowlisted =
    diffNameOnly.length > 0 &&
    diffNameOnly.every(isAllowlistedPath);
  if (allDiffAllowlisted && !diffHadNonAllowlistedFile) {
    return { sentinel: 'skipped-allowlisted' };
  }
  return { sentinel: 'passed' };
}

function decide(surface, hit, override) {
  // A match was found on a non-exempt surface.
  if (override.present && override.malformed) {
    return {
      sentinel: 'aborted-override-missing',
      surface,
      match: hit.match,
      patternName: hit.name,
      override: { present: true, malformed: true },
      abortMessage:
        `Merge blocked: privacy-gate-override line is malformed (empty reason after colon).\n` +
        `Required form: privacy-gate-override: <non-empty reason>\n` +
        `Match was on surface "${surface}" (pattern: ${hit.name}).`,
    };
  }
  if (override.present && !override.malformed) {
    return {
      sentinel: 'passed-with-override',
      surface,
      match: hit.match,
      patternName: hit.name,
      override: { present: true, reason: override.reason, malformed: false },
    };
  }
  return {
    sentinel: 'aborted-block',
    surface,
    match: hit.match,
    patternName: hit.name,
    abortMessage: formatAbortMessage({ patternName: hit.name, surface }),
  };
}

// Audit logger. Appends a single newline-terminated line to the unified
// override log at ~/.claude/.rule-12-overrides.log. The log path matches
// what parent-claude.md Rule 12 / Rule 16 already use.
export function logOverride({ prNumber, reason, surface, patternName, now = new Date() }) {
  const home = process.env.HOME || homedir();
  if (!home) return;
  const logPath = join(home, '.claude', '.rule-12-overrides.log');
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    const ts = now.toISOString();
    const line = `${ts} PRIVACY-GATE-OVERRIDE pr=${prNumber || 'unknown'} pattern=${patternName} surface=${surface} reason=${JSON.stringify(reason)}\n`;
    appendFileSync(logPath, line);
  } catch {
    // Best-effort — never fail the gate on log write failure.
  }
}

// CLI entry. SKILL.md invokes:
//   node lib/privacy-denylist-gate.mjs run --pr-number <N>
// Prints a JSON result to stdout (consumed by SKILL.md for the run record)
// and a human abort message to stderr on block. Exit codes:
//   0  passed | passed-with-override | skipped-allowlisted
//   1  aborted-block | aborted-override-missing
//   2  aborted-tool-failure (sha256 mismatch, gh auth, etc.)
async function cliMain(argv) {
  const cmd = argv[2];
  if (cmd === 'run') {
    return cmdRun(argv.slice(3));
  }
  if (cmd === 'verify-vendor') {
    const err = verifyVendorIntegrity();
    if (err) {
      process.stderr.write(`vendor-integrity-error: ${err}\n`);
      return 2;
    }
    process.stdout.write('vendor-integrity-ok\n');
    return 0;
  }
  process.stderr.write(`usage: privacy-denylist-gate.mjs run --pr-number <N>\n`);
  process.stderr.write(`       privacy-denylist-gate.mjs verify-vendor\n`);
  return 64;
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pr-number') out.prNumber = args[++i];
    else if (a === '--repo-root') out.repoRoot = args[++i];
    else if (a === '--json-only') out.jsonOnly = true;
  }
  return out;
}

function shellOut(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const stderr = (r.stderr || '').trim();
    const err = new Error(`${cmd} ${args.join(' ')} failed (status=${r.status}): ${stderr}`);
    err.status = r.status;
    err.stderr = stderr;
    throw err;
  }
  return (r.stdout || '').toString();
}

async function cmdRun(args) {
  const { prNumber, repoRoot: cliRepoRoot, jsonOnly } = parseArgs(args);
  const repoRoot = cliRepoRoot || REPO_ROOT;
  const result = { sentinel: null };
  // 1. Hard-block: vendor sha256 integrity (AC-4).
  const vendorErr = verifyVendorIntegrity(repoRoot);
  if (vendorErr) {
    result.sentinel = 'aborted-tool-failure';
    result.error = vendorErr;
    process.stderr.write(`Stage 5.6 aborted-tool-failure: ${vendorErr}\n`);
    process.stdout.write(JSON.stringify(result) + '\n');
    return 2;
  }
  // 2. Soft-warn: freshness (AC-4 warn-only).
  const fresh = checkVendorFreshness(repoRoot);
  if (fresh.stale) {
    process.stderr.write(
      `[ship] privacy-denylist vendor stale: vendored ${fresh.ageDays} days ago (${fresh.vendoredAt}); ` +
      `consider re-vendoring from upstream.\n`
    );
  }
  if (!prNumber) {
    result.sentinel = 'aborted-tool-failure';
    result.error = '--pr-number is required';
    process.stderr.write(`Stage 5.6 aborted-tool-failure: ${result.error}\n`);
    process.stdout.write(JSON.stringify(result) + '\n');
    return 2;
  }
  // 3. Collect surfaces via gh + git.
  let prBody, prTitle, branchName, commitMessages, diffNameOnly, diffContents;
  try {
    prBody = shellOut('gh', ['pr', 'view', prNumber, '--json', 'body', '-q', '.body']).trimEnd();
    prTitle = shellOut('gh', ['pr', 'view', prNumber, '--json', 'title', '-q', '.title']).trimEnd();
    branchName = shellOut('git', ['branch', '--show-current']).trim();
    // Detect default branch via the cached origin/HEAD symbolic-ref so the
    // gate works on repos that use `main` (agent-working-memory) AND repos
    // that use `master` (ai-brain). Falls back to `master` if the symbolic
    // ref is missing — matches the network-free pattern used by
    // hooks/session-bookmark.sh and skills/housekeep audit-repos.
    let defaultBranch;
    try {
      defaultBranch = shellOut('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).trim().replace(/^refs\/remotes\/origin\//, '');
    } catch {
      defaultBranch = 'master';
    }
    if (!defaultBranch) defaultBranch = 'master';
    const log = shellOut('git', ['log', `origin/${defaultBranch}..HEAD`, '--format=%H%x1f%B%x1e']);
    commitMessages = log
      .split('\x1e')
      .map(s => s.trim())
      .filter(Boolean)
      .map(rec => {
        const [sha, ...rest] = rec.split('\x1f');
        return { sha, message: rest.join('\x1f') };
      });
    const nameOnlyRaw = shellOut('gh', ['pr', 'diff', prNumber, '--name-only']);
    diffNameOnly = nameOnlyRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // Diff content: gh pr diff prints a unified diff; we treat the WHOLE
    // diff text as the "content" of each touched file (split by file
    // header). Simpler than reading each file's worktree state and
    // captures additions/deletions both ways.
    const diffText = shellOut('gh', ['pr', 'diff', prNumber]);
    diffContents = splitDiffByFile(diffText);
  } catch (e) {
    result.sentinel = 'aborted-tool-failure';
    result.error = e.message;
    process.stderr.write(`Stage 5.6 aborted-tool-failure: ${e.message}\n`);
    process.stdout.write(JSON.stringify(result) + '\n');
    return 2;
  }
  // 4. Run gate.
  const gateOut = runGate({
    prBody,
    prTitle,
    commitMessages,
    branchName,
    diffNameOnly,
    diffContents,
  });
  // 5. On passed-with-override: log to audit trail.
  if (gateOut.sentinel === 'passed-with-override') {
    logOverride({
      prNumber,
      reason: gateOut.override.reason,
      surface: gateOut.surface,
      patternName: gateOut.patternName,
    });
  }
  if (!jsonOnly && gateOut.abortMessage) {
    process.stderr.write(gateOut.abortMessage + '\n');
  }
  process.stdout.write(JSON.stringify(gateOut) + '\n');
  if (gateOut.sentinel === 'aborted-block' || gateOut.sentinel === 'aborted-override-missing') {
    return 1;
  }
  return 0;
}

// Split a unified diff into one entry per file, keyed by the post-image
// path from `+++ b/<path>` headers. Lines before the first file header
// are ignored.
export function splitDiffByFile(diffText) {
  const out = [];
  if (typeof diffText !== 'string' || diffText.length === 0) return out;
  const lines = diffText.split(/\r?\n/);
  let currentPath = null;
  let buf = [];
  const flush = () => {
    if (currentPath !== null) {
      out.push({ path: currentPath, content: buf.join('\n') });
    }
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentPath = null;
      buf = [];
      continue;
    }
    if (line.startsWith('+++ ')) {
      // +++ b/path/to/file  OR  +++ /dev/null (deletion)
      const rest = line.slice(4).trim();
      if (rest === '/dev/null') {
        currentPath = null;
      } else if (rest.startsWith('b/')) {
        currentPath = rest.slice(2);
      } else {
        currentPath = rest;
      }
      buf = [];
      continue;
    }
    if (currentPath !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// CLI bootstrap — only when invoked as a script, not when imported.
const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;
if (isMain) {
  cliMain(process.argv).then(code => process.exit(code)).catch(err => {
    process.stderr.write(`unexpected error: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}

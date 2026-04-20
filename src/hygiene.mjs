// Hygiene scanner: greps a directory tree for patterns that indicate real user
// content has leaked into the public repo. Exits 0 with no violations, 1 otherwise.
//
// Usage:
//   node src/hygiene.mjs [ROOT]   (default: current directory)
//
// Forbidden patterns:
//   - absolute Windows paths (C:\Users\<name>\... — anything past "Users\")
//   - absolute POSIX home paths (/home/<name>/... /Users/<name>/...)
//   - ~/.claude/ references (these identify a user's local Claude install)
//   - email shapes (someone@somewhere.tld)
//   - credential-looking tokens: ghp_*, gho_*, sk-*, xox[abpsr]-*, Bearer <hex>
//
// This file itself, docs/hygiene.md, tests/hygiene.test.mjs, and scripts/p1-acceptance.sh
// are ALLOWED to mention the patterns (because they document/test them). The allowlist
// is the only place those mentions may live.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

const ALLOWLIST = new Set([
  "src/hygiene.mjs",
  "tests/hygiene.test.mjs",
  "docs/hygiene.md",
  "scripts/p1-acceptance.sh",
  "README.md",
]);

const SKIP_DIRS = new Set([".git", "node_modules", ".vscode", ".idea"]);

// Patterns. Each is [name, regex].
const PATTERNS = [
  ["windows-user-path", /[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+\\/],
  ["posix-home-path", /\/(home|Users)\/[a-z][a-z0-9_.-]*\//],
  ["claude-home-ref", /~\/\.claude\//],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["openai-token", /\bsk-[A-Za-z0-9]{20,}\b/],
  ["slack-token", /\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/],
  ["bearer-hex", /\bBearer\s+[a-f0-9]{32,}\b/],
];

export function walk(root, out = []) {
  let entries;
  try { entries = readdirSync(root); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

export function scanFile(path, relPath) {
  const violations = [];
  if (ALLOWLIST.has(relPath)) return violations;
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return violations; }
  // Skip binary-ish files
  if (text.includes("\u0000")) return violations;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const [name, rx] of PATTERNS) {
      if (rx.test(lines[i])) {
        violations.push({ file: relPath, line: i + 1, pattern: name, text: lines[i].slice(0, 200) });
      }
    }
  }
  return violations;
}

// Return tracked files under `root` as absolute paths, or null if `root` is
// not inside a git repo (e.g., the tmp-dir seeded-probe test). The hygiene
// scanner's contract is "committed repo tree is clean", so we ask git what
// belongs to the committed tree rather than walking the filesystem and
// sweeping up untracked WIP.
function listTrackedFiles(root) {
  let out;
  try {
    out = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const text = out.toString("utf8");
  if (text.length === 0) return [];
  return text
    .split("\0")
    .filter(Boolean)
    .map(rel => (isAbsolute(rel) ? rel : join(root, rel)));
}

export function scanTree(root) {
  const tracked = listTrackedFiles(root);
  const files = tracked !== null ? tracked : walk(root);
  const all = [];
  for (const f of files) {
    const rel = relative(root, f).split(sep).join("/");
    all.push(...scanFile(f, rel));
  }
  return all;
}

if (process.argv[1]?.endsWith("hygiene.mjs")) {
  const root = process.argv[2] || process.cwd();
  const v = scanTree(root);
  if (v.length === 0) {
    process.stdout.write(`hygiene: clean (${root})\n`);
    process.exit(0);
  }
  for (const x of v) {
    process.stderr.write(`HYGIENE VIOLATION ${x.file}:${x.line} [${x.pattern}] ${x.text}\n`);
  }
  process.stderr.write(`\n${v.length} violation(s) found.\n`);
  process.exit(1);
}

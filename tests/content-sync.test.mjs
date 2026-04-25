// Content-sync tests.
//
// Covers the four PR-B-mandated new cases plus an end-to-end fixture sync:
//   - filter predicate (pinned vs. non-pinned, non-md, outside-topics)
//   - hash-based edit detection (UPDATE only emitted on byte change)
//   - idempotency (second run with no delta produces zero new commits)
//   - non-pinned exclusion (skip lines render with reason=non-pinned)
//   - end-to-end (B3): seed pinned card → run sync → assert exit 0,
//     file-at-expected-path, one new commit with stable subject prefix
//   - B3b push parity (no local-only commits remain after run)
//   - B7 a/b/c/d freshness branches for src/refresh.mjs fragment include
//
// All tests use isolated tmp dirs and the env-var seams documented in
// scripts/content-sync.mjs and src/refresh.mjs. None touch the user's
// real Claude home directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { computePlan, runSync } from "../scripts/content-sync.mjs";
import { shouldInclude } from "../scripts/lib/content-filter.mjs";
import { parseCard } from "../src/card-shape.mjs";
import { refresh } from "../src/refresh.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "content-sync");

// ---------------------------------------------------------------------------
// Helpers.

function makeCard({ id, topic, title, pinned, created = "2026-04-25" }) {
  return [
    "---",
    `id: ${id}`,
    `topic: ${topic}`,
    `title: ${title}`,
    `created: ${created}`,
    `pinned: ${pinned}`,
    "tags: []",
    "---",
    "",
    "## Decision",
    `Body for ${id}.`,
    "",
  ].join("\n");
}

function seedTierB(tierBRoot, cards) {
  for (const c of cards) {
    const dir = join(tierBRoot, "topics", c.topic);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${c.id}.md`), makeCard(c), "utf8");
  }
}

// Make a tmp dir, then init a bare-equivalent local `origin` git repo so
// `git clone` succeeds without network access. Returns { remoteUrl, cloneRoot }.
function makeLocalRemote(tmpRoot) {
  const bare = join(tmpRoot, "remote.git");
  mkdirSync(bare, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });

  // Seed the bare repo with one initial commit on main so clone has a target.
  const seed = join(tmpRoot, "seed");
  mkdirSync(seed, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: seed, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: seed, stdio: "ignore" });
  writeFileSync(join(seed, "README.md"), "# content\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: seed, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: seed, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: seed, stdio: "ignore" });
  execFileSync("git", ["push", "origin", "main"], { cwd: seed, stdio: "ignore" });

  return { remoteUrl: bare };
}

// ---------------------------------------------------------------------------
// 1. Filter predicate.

test("filter: pinned card under topics/ is included", () => {
  const card = makeCard({ id: "a", topic: "demo", title: "x", pinned: true });
  const parsed = parseCard(card);
  const decision = shouldInclude("topics/demo/a.md", parsed);
  assert.equal(decision.included, true);
  assert.equal(decision.reason, "pinned");
});

test("filter: non-pinned card excluded with reason=non-pinned", () => {
  const card = makeCard({ id: "b", topic: "demo", title: "x", pinned: false });
  const parsed = parseCard(card);
  const decision = shouldInclude("topics/demo/b.md", parsed);
  assert.equal(decision.included, false);
  assert.equal(decision.reason, "non-pinned");
});

test("filter: non-md file excluded with reason=non-md", () => {
  const decision = shouldInclude("topics/demo/notes.txt", null);
  assert.equal(decision.included, false);
  assert.equal(decision.reason, "non-md");
});

test("filter: file outside topics/ excluded", () => {
  const card = makeCard({ id: "c", topic: "demo", title: "x", pinned: true });
  const parsed = parseCard(card);
  const decision = shouldInclude("scratch/c.md", parsed);
  assert.equal(decision.included, false);
  assert.equal(decision.reason, "outside-topics");
});

// ---------------------------------------------------------------------------
// 2. Hash-based edit detection.

test("hash-edit: identical bytes produce no UPDATE action", () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-sync-hash-"));
  const root = join(tmp, "wm");
  const clone = join(tmp, "clone");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  mkdirSync(join(clone, "tier-b"), { recursive: true });
  seedTierB(join(root, "tier-b"), [{ id: "h1", topic: "demo", title: "x", pinned: true }]);
  // Mirror the same bytes into clone.
  const rel = "topics/demo/h1.md";
  const body = readFileSync(join(root, "tier-b", rel), "utf8");
  mkdirSync(join(clone, "tier-b", "topics", "demo"), { recursive: true });
  writeFileSync(join(clone, "tier-b", rel), body, "utf8");

  const plan = computePlan(join(root, "tier-b"), clone);
  const realActions = plan.filter((a) => a.kind !== "SKIP-FILTER");
  assert.equal(realActions.length, 0, "no real actions on identical bytes");
});

test("hash-edit: byte change produces UPDATE", () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-sync-hash2-"));
  const root = join(tmp, "wm");
  const clone = join(tmp, "clone");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  mkdirSync(join(clone, "tier-b"), { recursive: true });
  seedTierB(join(root, "tier-b"), [{ id: "h2", topic: "demo", title: "x", pinned: true }]);
  // Stale older copy in clone.
  const rel = "topics/demo/h2.md";
  mkdirSync(join(clone, "tier-b", "topics", "demo"), { recursive: true });
  writeFileSync(
    join(clone, "tier-b", rel),
    makeCard({ id: "h2", topic: "demo", title: "OLD-title", pinned: true }),
    "utf8",
  );

  const plan = computePlan(join(root, "tier-b"), clone);
  const updates = plan.filter((a) => a.kind === "UPDATE");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].relPath, rel);
});

// ---------------------------------------------------------------------------
// 3. Idempotency (no new commits on second run).

test("idempotent: second run with no local delta produces no new commits", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-sync-idem-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  seedTierB(join(root, "tier-b"), [{ id: "i1", topic: "demo", title: "x", pinned: true }]);

  const { remoteUrl } = makeLocalRemote(tmp);
  const clone = join(tmp, "clone");

  const env = {
    CONTENT_REPO_REMOTE: remoteUrl,
    CONTENT_REPO_CLONE: clone,
    CONTENT_REPO_BRANCH: "main",
    CONTENT_SYNC_AUTHOR_NAME: "Test",
    CONTENT_SYNC_AUTHOR_EMAIL: "test@test",
  };
  const oldEnv = saveEnv(env);
  applyEnv(env);
  try {
    const r1 = await runSync({ root, clone });
    assert.equal(r1.exitCode, 0);
    assert.equal(r1.committed, true);
    const sha1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim();

    const r2 = await runSync({ root, clone });
    assert.equal(r2.exitCode, 0);
    assert.equal(r2.committed, false, "second run should not commit");
    const sha2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim();
    assert.equal(sha1, sha2, "HEAD unchanged across runs");
  } finally {
    restoreEnv(oldEnv);
  }
});

// ---------------------------------------------------------------------------
// 4. Non-pinned exclusion (renders SKIP-FILTER reason=non-pinned in dry-run).

test("non-pinned exclusion: dry-run renders SKIP-FILTER reason=non-pinned", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-sync-skip-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  seedTierB(join(root, "tier-b"), [
    { id: "p1", topic: "demo", title: "pinned", pinned: true },
    { id: "n1", topic: "demo", title: "loose", pinned: false },
  ]);
  const clone = join(tmp, "clone");

  const r = await runSync({ root, clone, dryRun: true });
  assert.equal(r.exitCode, 0);
  // ADD for pinned, SKIP-FILTER for non-pinned. Sorted by relPath.
  assert.match(r.output, /ADD topics\/demo\/p1\.md/);
  assert.match(r.output, /SKIP-FILTER topics\/demo\/n1\.md reason=non-pinned/);
});

// ---------------------------------------------------------------------------
// 5. End-to-end fixture sync (B3 + B3b).

test("e2e: pinned card syncs to clone, exit 0, one commit with stable subject prefix, push parity", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-sync-e2e-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  seedTierB(join(root, "tier-b"), [{ id: "e1", topic: "demo", title: "x", pinned: true }]);
  const { remoteUrl } = makeLocalRemote(tmp);
  const clone = join(tmp, "clone");

  const env = {
    CONTENT_REPO_REMOTE: remoteUrl,
    CONTENT_REPO_CLONE: clone,
    CONTENT_REPO_BRANCH: "main",
    CONTENT_SYNC_AUTHOR_NAME: "Test",
    CONTENT_SYNC_AUTHOR_EMAIL: "test@test",
  };
  const oldEnv = saveEnv(env);
  applyEnv(env);
  try {
    const r = await runSync({ root, clone });

    // (a) exit 0
    assert.equal(r.exitCode, 0);
    assert.equal(r.committed, true);
    assert.equal(r.pushed, true);

    // (b) file at expected path
    const dest = join(clone, "tier-b", "topics", "demo", "e1.md");
    assert.ok(existsSync(dest), "card landed at expected path");

    // (c) one new commit with stable subject prefix
    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: clone, encoding: "utf8" }).trim();
    assert.match(subject, /^chore\(content-sync\): sync pinned cards/);

    // B3b: push parity — clone HEAD matches origin/main.
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim();
    const remoteSha = execFileSync("git", ["rev-parse", "origin/main"], { cwd: clone, encoding: "utf8" }).trim();
    assert.equal(headSha, remoteSha, "no local-only commits after sync");
  } finally {
    restoreEnv(oldEnv);
  }
});

// ---------------------------------------------------------------------------
// 6. B10 — sync failure is observable (exit !=0, single-line failure record).

test("failure: unreachable remote produces exit 1 + single-line failure record", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-sync-fail-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  seedTierB(join(root, "tier-b"), [{ id: "f1", topic: "demo", title: "x", pinned: true }]);
  const clone = join(tmp, "clone");
  // Bogus remote — clone will fail.
  const env = {
    CONTENT_REPO_REMOTE: join(tmp, "does-not-exist.git"),
    CONTENT_REPO_CLONE: clone,
    CONTENT_REPO_BRANCH: "main",
  };
  const oldEnv = saveEnv(env);
  applyEnv(env);
  try {
    const r = await runSync({ root, clone, retryBudget: 1 });
    assert.equal(r.exitCode, 1);
    const recordPath = join(clone, ".last-sync-error.log");
    assert.ok(existsSync(recordPath), "failure record exists");
    const body = readFileSync(recordPath, "utf8");
    const lines = body.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "single-line failure record");
    assert.match(lines[0], /class=/);
  } finally {
    restoreEnv(oldEnv);
  }
});

// ---------------------------------------------------------------------------
// 7. B7 — refresh.mjs Cairn fragment include, four branches.

function makeFragment({ stale = false } = {}) {
  const ts = stale ? "2020-01-01T00:00:00Z" : new Date().toISOString();
  return [
    "## Memory liveness",
    "",
    `_generated: ${ts} from /tmp/heartbeats.log_`,
    "",
    "- **ARMED** `h4` — last 2026-04-25T10:00:00Z (1m ago)",
    "- **ARMED** `h7` — last 2026-04-25T10:00:00Z (1m ago)",
    "",
  ].join("\n");
}

test("B7-(a): present and fresh — tier-a includes the fragment under heading", () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-refresh-a-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b", "topics", "demo"), { recursive: true });
  writeFileSync(
    join(root, "tier-b", "topics", "demo", "x.md"),
    makeCard({ id: "x", topic: "demo", title: "x", pinned: true }),
    "utf8",
  );
  const fragPath = join(tmp, "fragment.md");
  writeFileSync(fragPath, makeFragment(), "utf8");

  const r = refresh({ root, statusFragmentPath: fragPath });
  assert.match(r.content, /## Memory liveness/);
  assert.match(r.content, /ARMED.*h7/);
});

test("B7-(b): absent — refresh proceeds, no heading", () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-refresh-b-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b", "topics", "demo"), { recursive: true });
  writeFileSync(
    join(root, "tier-b", "topics", "demo", "x.md"),
    makeCard({ id: "x", topic: "demo", title: "x", pinned: true }),
    "utf8",
  );
  const fragPath = join(tmp, "does-not-exist.md");
  const r = refresh({ root, statusFragmentPath: fragPath });
  assert.ok(!r.content.includes("## Memory liveness"));
});

test("B7-(c): malformed (anchor missing) — refresh proceeds without malformed embed", () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-refresh-c-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b", "topics", "demo"), { recursive: true });
  writeFileSync(
    join(root, "tier-b", "topics", "demo", "x.md"),
    makeCard({ id: "x", topic: "demo", title: "x", pinned: true }),
    "utf8",
  );
  const fragPath = join(tmp, "fragment.md");
  writeFileSync(fragPath, "garbage with no anchor heading\n", "utf8");
  const r = refresh({ root, statusFragmentPath: fragPath });
  assert.ok(!r.content.includes("## Memory liveness"));
  // Optional one-line note is acceptable.
});

test("B7-(d): stale — fragment embedded with age annotation", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-refresh-d-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b", "topics", "demo"), { recursive: true });
  writeFileSync(
    join(root, "tier-b", "topics", "demo", "x.md"),
    makeCard({ id: "x", topic: "demo", title: "x", pinned: true }),
    "utf8",
  );
  const fragPath = join(tmp, "fragment.md");
  writeFileSync(fragPath, makeFragment({ stale: true }), "utf8");
  // Force the file mtime to ancient so refresh sees it as stale.
  const ancient = new Date("2020-01-01T00:00:00Z");
  const fs = await import("node:fs");
  fs.utimesSync(fragPath, ancient, ancient);

  const r = refresh({ root, statusFragmentPath: fragPath });
  assert.match(r.content, /## Memory liveness/);
  assert.match(r.content, /stale/i);
});

// ---------------------------------------------------------------------------
// Env helpers.

function saveEnv(keys) {
  const out = {};
  for (const k of Object.keys(keys)) out[k] = process.env[k];
  return out;
}

function applyEnv(env) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

function restoreEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// migrate.test.mjs
//
// Covers the AC-4 / AC-5 / AC-6 / AC-6b / AC-7 / AC-9 / AC-9b cases for the
// new `memory migrate-out` and `memory migrate-in` subcommands.
//
// All tests use isolated tmp dirs, a local bare repo as the "remote" backup
// repo (no network), and the env-var seams documented in
// scripts/migrate-out.mjs + scripts/migrate-in.mjs. None touch the user's
// real working tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import * as importedFs from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { runMigrateOut } from "../scripts/migrate-out.mjs";
import { runMigrateIn } from "../scripts/migrate-in.mjs";
import {
  getHostId,
  defaultMigrateBranch,
  isMainBranch,
  resolveStrategy,
  isPinned,
} from "../scripts/lib/migration-bundle.mjs";
import { findFirstMatch, RULE_SPEC_ALLOWLIST } from "../scripts/lib/privacy-denylist.mjs";

// --------------------------------------------------------------------
// Fixture-circularity guard helpers.
//
// The privacy denylist's whole point is to refuse to ship files that
// contain regulated tokens. If THIS test file embedded those tokens
// as literal source-level strings, the test file itself would be the
// leak the gate exists to catch (and a future cross-repo grep would
// trip on it). So every regulated token used as a fixture below is
// built at RUNTIME via String.fromCharCode / concatenation. The
// DENYLIST_PATTERNS regex still matches the runtime-built string
// because regex matching is byte-level — but a grep across this
// test directory for any contiguous regulated token returns zero
// hits.
//
// Same lesson the ai-brain Stage 5.6 work hit (pre-compact card
// 2026-05-06).

// 3-char employer brand token (uppercase). char codes 85, 79, 66.
const BRAND = String.fromCharCode(85, 79, 66);
// Lowercase brand variant (3 chars, char codes 117/111/98).
const BRAND_LOWER = String.fromCharCode(117, 111, 98);
// Spaced-acronym variant matching the regex
// /\bU[\s.][\s.]?O[\s.][\s.]?B\b/i — built via char-codes + literal
// punctuation so the source carries no contiguous regulated string.
const BRAND_SPACED_RUNTIME = String.fromCharCode(85) + "." +
  String.fromCharCode(79) + "." + String.fromCharCode(66) + ".";
// Lowercase spaced-acronym variant.
const BRAND_SPACED_LOWER = String.fromCharCode(117) + "." +
  String.fromCharCode(111) + "." + String.fromCharCode(98) + ".";
// Award-prefix matching the regex
// /Best\s+Foreign\s+Bank\s+in\s+Malaysia/i — built via concatenation
// so no contiguous award-name string appears in source.
const AWARD_PREFIX = "Best " + "Foreign " + "Bank";

// --------------------------------------------------------------------
// Helpers.

function makeCard({ id, topic, title, pinned, created = "2026-04-25", body = null }) {
  const lines = [
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
    body || `Body for ${id}.`,
    "",
  ];
  return lines.join("\n");
}

function seedTierB(tierBRoot, cards) {
  for (const c of cards) {
    const dir = join(tierBRoot, "topics", c.topic);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${c.id}.md`);
    writeFileSync(path, c.text || makeCard(c), "utf8");
  }
}

// Make a tmp dir, then init a bare-equivalent local "origin" git repo. The
// seed commit on `main` is empty-ish (just a README) so any tier-b/ tree
// shows up as fresh content. Returns { remoteUrl, tmpRoot }.
function makeLocalRemote(tmpRoot) {
  const bare = join(tmpRoot, "remote.git");
  mkdirSync(bare, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });

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

// Tree-hash helper (hashTierBTreeOf) is defined at the bottom; it's the
// round-trip equality oracle for AC-7.

// Save/restore env helpers.
function saveEnv(keys) {
  const out = {};
  for (const k of keys) out[k] = process.env[k];
  return out;
}
function applyEnv(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = v;
  }
}
function restoreEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// Init a git repo at tier-b root and commit everything currently there. Used
// by tests that need a local commit-time signal (AC-6 both-tracked case).
function gitInitAndCommit(rootDir, message = "seed") {
  execFileSync("git", ["init", "--initial-branch=main", rootDir], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: rootDir, stdio: "ignore" });
}

// --------------------------------------------------------------------
// 0. Unit tests for migration-bundle helpers.

test("migration-bundle: defaultMigrateBranch is non-main and date-stamped", () => {
  const branch = defaultMigrateBranch();
  assert.ok(!isMainBranch(branch), `default branch must not be main, got: ${branch}`);
  assert.match(branch, /^migration\/.+-\d{4}-\d{2}-\d{2}$/);
});

test("migration-bundle: getHostId is stable across calls and host-shaped", () => {
  const a = getHostId();
  const b = getHostId();
  assert.equal(a, b);
  assert.match(a, /^[a-z]+-[a-z0-9-]+-[0-9a-f]{4}$/);
});

test("migration-bundle: isPinned reads pinned: true correctly", () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-pin-"));
  const path = join(tmp, "card.md");
  writeFileSync(path, makeCard({ id: "p", topic: "demo", title: "x", pinned: true }), "utf8");
  assert.equal(isPinned(path), true);

  const path2 = join(tmp, "card2.md");
  writeFileSync(path2, makeCard({ id: "p2", topic: "demo", title: "x", pinned: false }), "utf8");
  assert.equal(isPinned(path2), false);
});

test("migration-bundle: resolveStrategy prefer-newer-commit picks larger ct", () => {
  assert.equal(resolveStrategy("prefer-newer-commit", 100, 200), "remote");
  assert.equal(resolveStrategy("prefer-newer-commit", 200, 100), "local");
  // Tie → local (Phase-0 semantic: don't disturb).
  assert.equal(resolveStrategy("prefer-newer-commit", 100, 100), "local");
});

test("migration-bundle: resolveStrategy prefer-newer-commit treats local Infinity as wins", () => {
  // AC 6b: untracked local card (Infinity) always wins over any remote ct.
  assert.equal(resolveStrategy("prefer-newer-commit", Infinity, 12345), "local");
  // Symmetric for remote.
  assert.equal(resolveStrategy("prefer-newer-commit", 12345, Infinity), "remote");
  // Both Infinity (degenerate) → local.
  assert.equal(resolveStrategy("prefer-newer-commit", Infinity, Infinity), "local");
});

test("migration-bundle: resolveStrategy prefer-local / prefer-remote ignore commit times", () => {
  assert.equal(resolveStrategy("prefer-local", 100, 999999), "local");
  assert.equal(resolveStrategy("prefer-remote", 999999, 100), "remote");
});

// --------------------------------------------------------------------
// 1. Privacy denylist module.

test("privacy-denylist: canonical brand string is matched", () => {
  const hit = findFirstMatch(`This card mentions ${BRAND} explicitly.`);
  assert.ok(hit, "expected a match");
  assert.equal(hit.name, "brand-bare");
});

test("privacy-denylist: case-insensitive — lowercase brand still matches", () => {
  const hit = findFirstMatch(`we worked at ${BRAND_LOWER} in 2022`);
  assert.ok(hit, "expected case-insensitive match");
  assert.equal(hit.name, "brand-bare");
});

test("privacy-denylist: brand variant 'BRAND Bank' matches via brand-bank pattern", () => {
  const hit = findFirstMatch(`${BRAND} Bank had branches in 5 countries`);
  assert.ok(hit);
  // Either brand-bare (matches the bare token) or brand-bank (matches
  // the full form) is acceptable — the bare pattern fires first since
  // it's listed first in DENYLIST_PATTERNS.
  assert.ok(hit.name === "brand-bare" || hit.name === "brand-bank");
});

test("privacy-denylist: spaced-acronym variant matches", () => {
  const hit = findFirstMatch(`${BRAND_SPACED_RUNTIME} Group rolled out a new product.`);
  assert.ok(hit, "expected variant match");
});

test("privacy-denylist: clean text returns null", () => {
  assert.equal(findFirstMatch("a top ASEAN bank rolled out a mobile app"), null);
  assert.equal(findFirstMatch(""), null);
  assert.equal(findFirstMatch(null), null);
});

test("privacy-denylist: award-prefix in Malaysia award name matches", () => {
  const hit = findFirstMatch(`won ${AWARD_PREFIX} in Malaysia (Asian Banker 2022)`);
  assert.ok(hit);
  assert.equal(hit.name, "award-best-foreign-bank-my");
});

// --------------------------------------------------------------------
// 2. AC-4: migrate-out exits 0 and creates the target branch (via local
// remote). Mirrors the spec verifier shape but uses local bare repo.

test("AC-4: migrate-out --target-branch test-fixture-1 exits 0 and creates branch", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-ac4-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  seedTierB(join(root, "tier-b"), [
    { id: "ac4-1", topic: "demo", title: "x", pinned: true },
    { id: "ac4-2", topic: "demo", title: "y", pinned: true },
    { id: "ac4-3", topic: "demo", title: "z", pinned: true },
  ]);
  const { remoteUrl } = makeLocalRemote(tmp);
  const clone = join(tmp, "migrate-clone");

  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_REPO_CLONE: clone,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const r = await runMigrateOut({ root, clone, targetBranch: "test-fixture-1" });
    assert.equal(r.exitCode, 0);
    assert.equal(r.committed, true);
    assert.equal(r.pushed, true);
    assert.equal(r.branch, "test-fixture-1");

    // ls-remote equivalent: query the bare repo for the branch ref.
    const refs = execFileSync("git", ["ls-remote", remoteUrl, "refs/heads/test-fixture-1"], { encoding: "utf8" }).trim();
    assert.match(refs, /^[0-9a-f]{40}\s+refs\/heads\/test-fixture-1$/, `expected branch ref, got: ${refs}`);
  } finally {
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 3. AC-5: migrate-in --strategy prefer-remote reproduces the fixture
// tree-hash exactly (round-trip).

test("AC-5: migrate-in reproduces fixture tree-hash with prefer-remote", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-ac5-"));
  const root1 = join(tmp, "wm1");
  mkdirSync(join(root1, "tier-b"), { recursive: true });
  seedTierB(join(root1, "tier-b"), [
    { id: "rt1", topic: "demo", title: "first", pinned: true },
    { id: "rt2", topic: "policies", title: "second", pinned: true },
  ]);
  const fixtureHash = hashTierBTreeOf(join(root1, "tier-b"));

  const { remoteUrl } = makeLocalRemote(tmp);
  const cloneOut = join(tmp, "out-clone");
  const cloneIn = join(tmp, "in-clone");
  const root2 = join(tmp, "wm2");
  mkdirSync(join(root2, "tier-b"), { recursive: true });

  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    // OUT.
    const ro = await runMigrateOut({ root: root1, clone: cloneOut, targetBranch: "rt-branch" });
    assert.equal(ro.exitCode, 0);

    // IN, with prefer-remote so remote always wins. Fresh empty local.
    const ri = await runMigrateIn({
      root: root2,
      clone: cloneIn,
      fromBranch: "rt-branch",
      strategy: "prefer-remote",
    });
    assert.equal(ri.exitCode, 0, `expected 0, got ${ri.exitCode} (${ri.error || ""})`);

    const restoredHash = hashTierBTreeOf(join(root2, "tier-b"));
    assert.equal(restoredHash, fixtureHash, "tree-hash equals fixture's after round-trip");
  } finally {
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 4. AC-7: round-trip preserves frontmatter + body byte-equal.

test("AC-7: round-trip is byte-equal across migrate-out → migrate-in", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-ac7-"));
  const root1 = join(tmp, "wm1");
  mkdirSync(join(root1, "tier-b"), { recursive: true });
  // Use deliberately wonky bytes — extra blank lines, trailing spaces, an
  // odd unicode char — so any canonicalization would show up.
  const oddBody = "## Decision\n  trailing-space   \n\nBody with em-dash — and 中文 字符.\n\n\n";
  seedTierB(join(root1, "tier-b"), [{
    id: "byte-1",
    topic: "demo",
    title: "byte fidelity",
    pinned: true,
    text: makeCard({ id: "byte-1", topic: "demo", title: "byte fidelity", pinned: true, body: oddBody }),
  }]);

  const fixtureBytes = readFileSync(
    join(root1, "tier-b", "topics", "demo", "byte-1.md"),
  );

  const { remoteUrl } = makeLocalRemote(tmp);
  const root2 = join(tmp, "wm2");
  mkdirSync(join(root2, "tier-b"), { recursive: true });

  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const ro = await runMigrateOut({
      root: root1,
      clone: join(tmp, "out-clone"),
      targetBranch: "byte-branch",
    });
    assert.equal(ro.exitCode, 0);

    const ri = await runMigrateIn({
      root: root2,
      clone: join(tmp, "in-clone"),
      fromBranch: "byte-branch",
      strategy: "prefer-remote",
    });
    assert.equal(ri.exitCode, 0);

    const restoredBytes = readFileSync(
      join(root2, "tier-b", "topics", "demo", "byte-1.md"),
    );
    assert.deepEqual(
      Array.from(restoredBytes),
      Array.from(fixtureBytes),
      "round-trip is byte-equal",
    );
  } finally {
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 5. AC-6: prefer-newer-commit, both-tracked. The remote-side commit is
// strictly newer in seconds, so remote wins.

test("AC-6: prefer-newer-commit both-tracked → newer side wins", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-ac6-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  // Seed an older copy locally.
  seedTierB(join(root, "tier-b"), [{
    id: "conflict-1",
    topic: "demo",
    title: "OLD local",
    pinned: true,
  }]);
  // Init a git repo at the WM root and commit so the local side has a ct.
  gitInitAndCommit(root, "old commit");

  // Sleep 2s (commit-time resolution is in seconds; we need a strict
  // ordering across two commits).
  await new Promise((r) => setTimeout(r, 2100));

  // Prepare a "fresh remote" by seeding a fresher copy in a separate
  // temp tier-b root, migrate-out it, then migrate-in.
  const root2 = join(tmp, "wm2");
  mkdirSync(join(root2, "tier-b"), { recursive: true });
  seedTierB(join(root2, "tier-b"), [{
    id: "conflict-1",
    topic: "demo",
    title: "NEW remote",
    pinned: true,
  }]);
  const { remoteUrl } = makeLocalRemote(tmp);

  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    // Push the newer remote.
    const ro = await runMigrateOut({
      root: root2,
      clone: join(tmp, "out-clone"),
      targetBranch: "conflict-branch",
    });
    assert.equal(ro.exitCode, 0);

    // Apply onto the older local with prefer-newer-commit.
    const ri = await runMigrateIn({
      root,
      clone: join(tmp, "in-clone"),
      fromBranch: "conflict-branch",
      strategy: "prefer-newer-commit",
    });
    assert.equal(ri.exitCode, 0);

    // Local card was overwritten by the newer remote.
    const restored = readFileSync(
      join(root, "tier-b", "topics", "demo", "conflict-1.md"),
      "utf8",
    );
    assert.match(restored, /title:\s*NEW remote/);
    assert.ok(!/title:\s*OLD local/.test(restored));
  } finally {
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 6. AC-6b (post-mtime-fix): prefer-newer-commit, local-untracked WITH a
// fresh mtime (user just edited the card locally). Local mtime > remote ct
// → local wins. Replaces the pre-fix Infinity-always-wins semantic with
// "freshest local edit wins" — same intent, honest implementation.
//
// The companion test "AC-6c: stale-local-untracked loses to fresh-remote"
// (added below) verifies the intentionally-changed half: when local mtime
// is older than remote ct, remote correctly wins.

test("AC-6b: prefer-newer-commit preserves locally-fresh-untracked cards (mtime > remote-ct)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-ac6b-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  // Local: untracked (no git init).
  seedTierB(join(root, "tier-b"), [{
    id: "untracked-1",
    topic: "demo",
    title: "PRESERVE local untracked",
    pinned: true,
  }]);

  // Remote: create a NEW remote-side copy (different content) and push.
  const root2 = join(tmp, "wm2");
  mkdirSync(join(root2, "tier-b"), { recursive: true });
  seedTierB(join(root2, "tier-b"), [{
    id: "untracked-1",
    topic: "demo",
    title: "REMOTE side",
    pinned: true,
  }]);

  const { remoteUrl } = makeLocalRemote(tmp);
  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const ro = await runMigrateOut({
      root: root2,
      clone: join(tmp, "out-clone"),
      targetBranch: "untracked-branch",
    });
    assert.equal(ro.exitCode, 0);

    // Bump local mtime to "freshly edited" (1 hour into the future) so the
    // mtime-based local-ct strictly exceeds the remote commit time.
    // Without this stamp, sub-second timing decides who wins under the new
    // semantic — flaky. The +3600s is a deterministic guard that mirrors
    // a real "user just edited this card locally" workflow.
    const localPath = join(root, "tier-b", "topics", "demo", "untracked-1.md");
    const future = Math.floor(Date.now() / 1000) + 3600;
    importedFs.utimesSync(localPath, future, future);

    const ri = await runMigrateIn({
      root,
      clone: join(tmp, "in-clone"),
      fromBranch: "untracked-branch",
      strategy: "prefer-newer-commit",
    });
    assert.equal(ri.exitCode, 0);

    // Local fresh-untracked card preserved (NOT overwritten by remote).
    const restored = readFileSync(localPath, "utf8");
    assert.match(restored, /title:\s*PRESERVE local untracked/);
    assert.ok(!/title:\s*REMOTE side/.test(restored));
  } finally {
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 6c. AC-6c (new, mtime-fix): stale local-untracked card loses to
// fresh-remote. Closes the silent-degenerate gap: pre-fix, every
// non-git-rooted local card was treated as Infinity (always wins),
// regardless of when it was actually copied/edited. Post-fix, an old
// local copy correctly loses to a freshly-committed remote edit.

test("AC-6c: prefer-newer-commit overwrites stale-local-untracked from fresh-remote (mtime < remote-ct)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-ac6c-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  // Local: untracked (no git init), with mtime stamped to 1 hour in the past.
  seedTierB(join(root, "tier-b"), [{
    id: "stale-1",
    topic: "demo",
    title: "STALE local",
    pinned: true,
  }]);
  const localPath = join(root, "tier-b", "topics", "demo", "stale-1.md");
  const past = Math.floor(Date.now() / 1000) - 3600;
  importedFs.utimesSync(localPath, past, past);

  const root2 = join(tmp, "wm2");
  mkdirSync(join(root2, "tier-b"), { recursive: true });
  seedTierB(join(root2, "tier-b"), [{
    id: "stale-1",
    topic: "demo",
    title: "FRESH remote",
    pinned: true,
  }]);

  const { remoteUrl } = makeLocalRemote(tmp);
  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const ro = await runMigrateOut({
      root: root2,
      clone: join(tmp, "out-clone"),
      targetBranch: "fresh-remote-branch",
    });
    assert.equal(ro.exitCode, 0);

    const ri = await runMigrateIn({
      root,
      clone: join(tmp, "in-clone"),
      fromBranch: "fresh-remote-branch",
      strategy: "prefer-newer-commit",
    });
    assert.equal(ri.exitCode, 0);

    // The decision matches copy-from-remote with finite local-ct (mtime,
    // not Infinity). This is the round-trip-honesty signal — pre-fix this
    // would have been "keep-local local-ct=Infinity remote-ct=...".
    const decision = ri.decisions.find((d) => d.relPath === "topics/demo/stale-1.md");
    assert.equal(decision.action, "copy-from-remote");
    assert.match(decision.reason, /local-ct=\d+/);
    assert.ok(!/local-ct=Infinity/.test(decision.reason));

    const restored = readFileSync(localPath, "utf8");
    assert.match(restored, /title:\s*FRESH remote/);
    assert.ok(!/title:\s*STALE local/.test(restored));
  } finally {
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 6d. AC-6d (new, mtime-fix): copy-step mtime stamp. After migrate-in
// copies a card from a remote commit at epoch T2, the local file's mtime
// equals T2 within ±1s tolerance. Pairs with AC-6c — without this stamp,
// round-trip migrate-in would always see local mtime=copy-time which
// drifts further from remote-ct each round.

test("AC-6d: copy-step mtime stamp matches source commit committed-date (±1s)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-ac6d-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  // Local starts EMPTY — the card will land via add-from-remote.

  const root2 = join(tmp, "wm2");
  mkdirSync(join(root2, "tier-b"), { recursive: true });
  seedTierB(join(root2, "tier-b"), [{
    id: "stamped-1",
    topic: "demo",
    title: "STAMPED",
    pinned: true,
  }]);

  const { remoteUrl } = makeLocalRemote(tmp);
  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const ro = await runMigrateOut({
      root: root2,
      clone: join(tmp, "out-clone"),
      targetBranch: "stamp-branch",
    });
    assert.equal(ro.exitCode, 0);

    const ri = await runMigrateIn({
      root,
      clone: join(tmp, "in-clone"),
      fromBranch: "stamp-branch",
      strategy: "prefer-newer-commit",
    });
    assert.equal(ri.exitCode, 0);

    // Look up the remote commit time for the card via git log on the in-clone.
    const remoteClone = join(tmp, "in-clone");
    const remoteCt = Number.parseInt(
      execFileSync(
        "git",
        ["log", "-1", "--format=%ct", "--", "tier-b/topics/demo/stamped-1.md"],
        { cwd: remoteClone, encoding: "utf8" },
      ).trim(),
      10,
    );
    assert.ok(Number.isFinite(remoteCt), "remoteCt must be a finite epoch second");

    const localPath = join(root, "tier-b", "topics", "demo", "stamped-1.md");
    const localMtimeS = importedFs.statSync(localPath).mtimeMs / 1000;
    assert.ok(
      Math.abs(localMtimeS - remoteCt) <= 1,
      `expected local mtime ≈ remote ct (${remoteCt}); got ${localMtimeS} (delta=${localMtimeS - remoteCt}s)`,
    );
  } finally {
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 6e. AC-6e (new, mtime-fix): round-trip-no-change honesty. After a
// migrate-in stamps mtimes to source-commit-cts, an immediate second
// migrate-in --dry-run shows ALL keep-local decisions with finite
// local-ct (not Infinity) for both-exist cards. Pre-fix every such line
// would have shown local-ct=Infinity, masking any future legitimate
// remote edit.

test("AC-6e: round-trip migrate-in shows finite local-ct (not Infinity) on second invocation", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-ac6e-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });

  const root2 = join(tmp, "wm2");
  mkdirSync(join(root2, "tier-b"), { recursive: true });
  seedTierB(join(root2, "tier-b"), [
    { id: "rt-1", topic: "demo", title: "ROUND-TRIP-1", pinned: true },
    { id: "rt-2", topic: "demo", title: "ROUND-TRIP-2", pinned: true },
  ]);

  const { remoteUrl } = makeLocalRemote(tmp);
  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const ro = await runMigrateOut({
      root: root2,
      clone: join(tmp, "out-clone"),
      targetBranch: "rt-branch",
    });
    assert.equal(ro.exitCode, 0);

    // First migrate-in: lands the cards from remote, stamps local mtimes.
    const ri1 = await runMigrateIn({
      root,
      clone: join(tmp, "in-clone"),
      fromBranch: "rt-branch",
      strategy: "prefer-newer-commit",
    });
    assert.equal(ri1.exitCode, 0);
    assert.equal(ri1.written, 2);

    // Second migrate-in (dry-run): expect both cards keep-local with
    // finite local-ct, equal to remote-ct.
    const ri2 = await runMigrateIn({
      root,
      clone: join(tmp, "in-clone-2"),
      fromBranch: "rt-branch",
      strategy: "prefer-newer-commit",
      dryRun: true,
    });
    assert.equal(ri2.exitCode, 0);
    for (const d of ri2.decisions) {
      assert.equal(d.action, "keep-local", `expected keep-local for ${d.relPath}`);
      assert.ok(
        !/local-ct=Infinity/.test(d.reason),
        `expected finite local-ct in reason; got: ${d.reason}`,
      );
      assert.match(d.reason, /local-ct=\d+/);
    }
  } finally {
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 6f. AC-6f (new, mtime-fix): local-only short-circuit preserved. A card
// that exists only locally (no remote counterpart) still keep-locals via
// planMerge's short-circuit (action="keep-local", reason="remote-missing"),
// never entering strategy resolution. This is the unchanged half of the
// behavior, regression-guarded so a future refactor doesn't accidentally
// treat local-only cards as both-exist.

test("AC-6f: local-only card keeps-local via short-circuit (reason=remote-missing, never enters strategy)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-ac6f-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  seedTierB(join(root, "tier-b"), [{
    id: "local-only-1",
    topic: "demo",
    title: "LOCAL ONLY",
    pinned: true,
  }]);

  // Remote starts EMPTY (no card with the same path).
  const root2 = join(tmp, "wm2");
  mkdirSync(join(root2, "tier-b"), { recursive: true });
  seedTierB(join(root2, "tier-b"), [{
    id: "different-card",
    topic: "demo",
    title: "DIFFERENT",
    pinned: true,
  }]);

  const { remoteUrl } = makeLocalRemote(tmp);
  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const ro = await runMigrateOut({
      root: root2,
      clone: join(tmp, "out-clone"),
      targetBranch: "local-only-branch",
    });
    assert.equal(ro.exitCode, 0);

    const ri = await runMigrateIn({
      root,
      clone: join(tmp, "in-clone"),
      fromBranch: "local-only-branch",
      strategy: "prefer-newer-commit",
      dryRun: true,
    });
    assert.equal(ri.exitCode, 0);

    const localOnly = ri.decisions.find((d) => d.relPath === "topics/demo/local-only-1.md");
    assert.equal(localOnly.action, "keep-local");
    assert.equal(localOnly.reason, "remote-missing"); // short-circuit reason, NOT strategy=...
    assert.ok(!/strategy=/.test(localOnly.reason), "must not enter strategy resolution");

    // The remote-only card lands as add-from-remote, no comparison.
    const remoteOnly = ri.decisions.find((d) => d.relPath === "topics/demo/different-card.md");
    assert.equal(remoteOnly.action, "add-from-remote");
    assert.equal(remoteOnly.reason, "local-missing");
  } finally {
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 7. --include-non-pinned: non-pinned cards make it into the bundle.

test("migrate-out: --include-non-pinned bundles unpinned cards", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-incl-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  seedTierB(join(root, "tier-b"), [
    { id: "p1", topic: "demo", title: "pinned", pinned: true },
    { id: "n1", topic: "demo", title: "loose", pinned: false },
  ]);
  const { remoteUrl } = makeLocalRemote(tmp);

  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    // Without flag: only pinned should land.
    const r1 = await runMigrateOut({
      root,
      clone: join(tmp, "clone1"),
      targetBranch: "incl-pinned-only",
    });
    assert.equal(r1.exitCode, 0);
    assert.equal(r1.bundled, 1);

    // With flag: both land.
    const r2 = await runMigrateOut({
      root,
      clone: join(tmp, "clone2"),
      targetBranch: "incl-all",
      includeNonPinned: true,
    });
    assert.equal(r2.exitCode, 0);
    assert.equal(r2.bundled, 2);
  } finally {
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 8. AC-9b: privacy denylist rejects canonical and variant fixtures, no
// branches are pushed.

test("AC-9b: privacy denylist rejects canonical brand fixture, no push", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-priv-1-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  // Card body contains the canonical regulated token.
  seedTierB(join(root, "tier-b"), [{
    id: "leak-1",
    topic: "demo",
    title: "harmless title",
    pinned: true,
    text: makeCard({
      id: "leak-1",
      topic: "demo",
      title: "harmless title",
      pinned: true,
      body: `## Decision\nWe shipped a feature for ${BRAND} last quarter.\n`,
    }),
  }]);
  const { remoteUrl } = makeLocalRemote(tmp);

  // Capture stderr written via the CLI.
  let captured = "";
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured += chunk?.toString?.() ?? String(chunk);
    return true;
  };

  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const r = await runMigrateOut({
      root,
      clone: join(tmp, "clone"),
      targetBranch: "test-privacy-rejection-1",
    });
    assert.notEqual(r.exitCode, 0, "expected non-zero exit for privacy block");
    assert.equal(r.errClass, "privacy-block");
    assert.match(captured, /PRIVACY-BLOCK/);

    // Branch must not exist on remote.
    const refs = execFileSync("git", ["ls-remote", remoteUrl, "refs/heads/test-privacy-rejection-1"], { encoding: "utf8" }).trim();
    assert.equal(refs, "", "no branch should be pushed");
  } finally {
    process.stderr.write = origWrite;
    restoreEnv(old);
  }
});

test("AC-9b: privacy denylist rejects mixed-case/spaced brand variant fixture, no push", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-priv-2-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  // Variant: lowercase + spacing form. The denylist must match
  // case-insensitively per the privacy spec.
  seedTierB(join(root, "tier-b"), [{
    id: "leak-2",
    topic: "demo",
    title: "harmless title",
    pinned: true,
    text: makeCard({
      id: "leak-2",
      topic: "demo",
      title: "harmless title",
      pinned: true,
      body: `## Decision\nWe partnered with ${BRAND_SPACED_LOWER} group on a regional rollout.\n`,
    }),
  }]);
  const { remoteUrl } = makeLocalRemote(tmp);

  let captured = "";
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured += chunk?.toString?.() ?? String(chunk);
    return true;
  };

  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const r = await runMigrateOut({
      root,
      clone: join(tmp, "clone"),
      targetBranch: "test-privacy-rejection-2",
    });
    assert.notEqual(r.exitCode, 0, "expected non-zero exit for variant privacy block");
    assert.equal(r.errClass, "privacy-block");
    assert.match(captured, /PRIVACY-BLOCK/);

    const refs = execFileSync("git", ["ls-remote", remoteUrl, "refs/heads/test-privacy-rejection-2"], { encoding: "utf8" }).trim();
    assert.equal(refs, "", "no branch should be pushed for variant");
  } finally {
    process.stderr.write = origWrite;
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 8b. AC-1 / AC-4 / AC-5: rule-spec allowlist coverage.
//
// AC-1: RULE_SPEC_ALLOWLIST exports exactly the two known rule-spec
// paths and nothing else.
//
// AC-4: a card AT one of the allowlisted paths containing the
// regulated token is admitted (migrate-out does NOT reject).
//
// AC-5: allowlist is path-pinned, NOT glob-pinned. A sibling card at
// `topics/privacy/some-other-card.md` (NOT in the literal allowlist)
// containing the regulated token IS rejected.

test("AC-1: RULE_SPEC_ALLOWLIST exports exactly the two known rule-spec paths", () => {
  const sorted = [...RULE_SPEC_ALLOWLIST].sort();
  assert.deepEqual(sorted, [
    "topics/privacy/no-employer-brand.md",
    "topics/privacy/no-linkedin-on-github.md",
  ]);
  // Frozen-wrapper intent: the binding is held in module scope and
  // wrapped in Object.freeze. Note: Object.freeze on a Set does NOT
  // make the internal storage immutable (V8 quirk — Sets are exotic
  // objects), so we don't assert .add() throws. The freeze is
  // documentary intent + prevents reassignment of own properties on
  // the Set instance object.
  assert.equal(Object.isFrozen(RULE_SPEC_ALLOWLIST), true);
});

test("AC-4: allowlisted rule-spec card containing regulated token is admitted", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-allow-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  // Card at topics/privacy/no-employer-brand.md — the rule-spec card.
  // Body legitimately carries the regulated token because this IS the
  // rule that bans it elsewhere.
  seedTierB(join(root, "tier-b"), [{
    id: "no-employer-brand",
    topic: "privacy",
    title: "rule spec",
    pinned: true,
    text: makeCard({
      id: "no-employer-brand",
      topic: "privacy",
      title: "rule spec",
      pinned: true,
      body: `## Decision\nNever write ${BRAND} anywhere except this card.\n`,
    }),
  }]);
  const { remoteUrl } = makeLocalRemote(tmp);

  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const r = await runMigrateOut({
      root,
      clone: join(tmp, "clone"),
      targetBranch: "test-allowlist-admit",
    });
    assert.equal(r.exitCode, 0, `expected admit, got ${r.exitCode} (${r.error || ""})`);
    assert.equal(r.errClass, undefined);
    // Branch is on remote.
    const refs = execFileSync(
      "git", ["ls-remote", remoteUrl, "refs/heads/test-allowlist-admit"],
      { encoding: "utf8" },
    ).trim();
    assert.match(refs, /^[0-9a-f]{40}\s+refs\/heads\/test-allowlist-admit$/);
  } finally {
    restoreEnv(old);
  }
});

test("AC-4: allowlist + non-allowlisted leak coexist → only the leak is reported", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-mixed-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  // One allowlisted rule-spec card with the token (admitted).
  // One non-allowlisted card with the token (must trip privacy-block,
  // and only THIS card should appear in the violation list).
  seedTierB(join(root, "tier-b"), [
    {
      id: "no-employer-brand",
      topic: "privacy",
      title: "rule spec",
      pinned: true,
      text: makeCard({
        id: "no-employer-brand",
        topic: "privacy",
        title: "rule spec",
        pinned: true,
        body: `## Decision\nNever write ${BRAND} anywhere except this card.\n`,
      }),
    },
    {
      id: "leak-third-party",
      topic: "migration",
      title: "leaks the token",
      pinned: true,
      text: makeCard({
        id: "leak-third-party",
        topic: "migration",
        title: "leaks the token",
        pinned: true,
        body: `## Decision\nWe shipped a feature for ${BRAND} last quarter.\n`,
      }),
    },
  ]);
  const { remoteUrl } = makeLocalRemote(tmp);

  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const r = await runMigrateOut({
      root,
      clone: join(tmp, "clone"),
      targetBranch: "test-allowlist-mixed",
    });
    assert.notEqual(r.exitCode, 0, "expected privacy-block");
    assert.equal(r.errClass, "privacy-block");
    // Exactly ONE violation, and it's the third-party card — not the
    // allowlisted rule-spec card.
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].relPath, "topics/migration/leak-third-party.md");
  } finally {
    restoreEnv(old);
  }
});

test("AC-5: allowlist is path-pinned — sibling topics/privacy/* card with token is rejected", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-pinned-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  // A NEW card under topics/privacy/ that is NOT in the allowlist.
  // This must be rejected — confirms we pin to exact paths, not a
  // glob like topics/privacy/*.
  seedTierB(join(root, "tier-b"), [{
    id: "some-other-card",
    topic: "privacy",
    title: "not the rule spec",
    pinned: true,
    text: makeCard({
      id: "some-other-card",
      topic: "privacy",
      title: "not the rule spec",
      pinned: true,
      body: `## Decision\nWe accidentally mentioned ${BRAND} here. Should be rejected.\n`,
    }),
  }]);
  const { remoteUrl } = makeLocalRemote(tmp);

  const env = {
    MIGRATE_REPO_REMOTE: remoteUrl,
    MIGRATE_AUTHOR_NAME: "Test",
    MIGRATE_AUTHOR_EMAIL: "test@test",
  };
  const old = saveEnv(Object.keys(env));
  applyEnv(env);
  try {
    const r = await runMigrateOut({
      root,
      clone: join(tmp, "clone"),
      targetBranch: "test-allowlist-pinned",
    });
    assert.notEqual(r.exitCode, 0, "sibling under topics/privacy/ must be rejected");
    assert.equal(r.errClass, "privacy-block");
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].relPath, "topics/privacy/some-other-card.md");
  } finally {
    restoreEnv(old);
  }
});

// --------------------------------------------------------------------
// 9. Default branch refusal — never write to 'main' / 'master'.

test("migrate-out: refuses to push to 'main' branch", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-prot-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  seedTierB(join(root, "tier-b"), [{ id: "p1", topic: "demo", title: "x", pinned: true }]);
  const r = await runMigrateOut({ root, clone: join(tmp, "clone"), targetBranch: "main" });
  assert.notEqual(r.exitCode, 0);
  assert.equal(r.errClass, "protected-branch");
});

test("migrate-out: refuses to push to 'master' branch", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-mig-prot2-"));
  const root = join(tmp, "wm");
  mkdirSync(join(root, "tier-b"), { recursive: true });
  seedTierB(join(root, "tier-b"), [{ id: "p1", topic: "demo", title: "x", pinned: true }]);
  const r = await runMigrateOut({ root, clone: join(tmp, "clone"), targetBranch: "master" });
  assert.notEqual(r.exitCode, 0);
  assert.equal(r.errClass, "protected-branch");
});

// --------------------------------------------------------------------
// Helper: tree-hash. Self-contained, sync, no external state.

function hashTierBTreeOf(tierBRoot) {
  const topics = join(tierBRoot, "topics");
  const out = [];
  if (!existsSync(topics)) return "EMPTY";
  walk(topics);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = createHash("sha256");
  for (const e of out) {
    h.update(e.rel);
    h.update("\0");
    h.update(e.bytes);
    h.update("\0");
  }
  return h.digest("hex");

  function walk(dir) {
    let entries;
    try { entries = importedFs.readdirSync(dir); } catch { return; }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      let st;
      try { st = importedFs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name.endsWith(".md")) {
        const rel = full.slice(topics.length + 1).split(sep).join("/");
        out.push({ rel, bytes: readFileSync(full) });
      }
    }
  }
}

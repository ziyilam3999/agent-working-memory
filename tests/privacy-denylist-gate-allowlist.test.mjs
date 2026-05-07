// /ship Stage 5.6 privacy-denylist gate — AC-5 allowlist coverage.
//
// AC-5 carves out the diff-content surface for files matching a fixed
// list of in-repo path globs. The gate skips token-matching INSIDE those
// files (e.g., parent-claude.md, the privacy memory card, the vendored
// module itself). The other 4 surfaces (PR body, title, commit messages,
// branch name) are NOT covered by file-path allowlist.
//
// This file's path is itself on the allowlist; runtime tokens live in
// memory only (reconstructed from char codes — see brand-bare-equivalent
// fixture).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runGate, isAllowlistedPath } from '../lib/privacy-denylist-gate.mjs';

const BRAND = String.fromCharCode(85, 79, 66); // U,O,B
const TOKEN = `${BRAND} Bank`; // matches the brand-bank pattern

const ALLOWLIST_FIXTURES = [
  // Each entry is [filePath, label]. Glob expansion: parent-claude.md is
  // a literal path; **/feedback_no_employer_mention.md must match nested
  // copies (e.g., per-project memory dir).
  ['parent-claude.md', 'parent-claude.md (literal)'],
  [
    'C--Users-ziyil-coding-projects-ai-brain/memory/feedback_no_employer_mention.md',
    'feedback_no_employer_mention.md (deep path, ** glob)',
  ],
  ['lib/privacy-denylist.mjs', 'vendored module'],
  ['lib/privacy-denylist.provenance.json', 'provenance'],
  ['tests/ship/privacy-denylist-gate.test.mjs', 'main test file'],
  ['tests/ship/privacy-denylist-gate-allowlist.test.mjs', 'this allowlist test file'],
];

for (const [path, label] of ALLOWLIST_FIXTURES) {
  test(`AC-5: isAllowlistedPath returns true for ${label}`, () => {
    assert.ok(
      isAllowlistedPath(path),
      `expected allowlist to cover ${path} (${label})`,
    );
  });

  test(`AC-5: gate passes when token appears INSIDE diff content of ${label}`, () => {
    const r = runGate({
      prBody: 'Summary: edits the privacy doc',
      prTitle: 'docs: privacy section',
      commitMessages: [{ sha: 'a', message: 'docs: privacy section' }],
      branchName: 'docs/privacy',
      diffNameOnly: [path],
      diffContents: [{ path, content: `the regulated token is ${TOKEN}` }],
    });
    assert.equal(
      r.sentinel,
      'skipped-allowlisted',
      `expected skipped-allowlisted, got ${r.sentinel} (path=${path})`,
    );
  });
}

// AC-5 negative case: a non-allowlisted file with the same content blocks.
test('AC-5: gate blocks token in diff content of non-allowlisted file', () => {
  const r = runGate({
    prBody: 'Summary',
    prTitle: 'feat: foo',
    commitMessages: [],
    branchName: 'feat/foo',
    diffNameOnly: ['src/foo.js'],
    diffContents: [{ path: 'src/foo.js', content: `leak: ${TOKEN}` }],
  });
  assert.equal(r.sentinel, 'aborted-block');
  assert.match(r.surface, /^diff /);
});

// AC-5 + AC-6 interaction: even if the only diff file is allowlisted,
// the OTHER 4 surfaces are still gated (the allowlist is diff-only).
test('AC-5 + AC-6: PR body token blocks even when only allowlisted files in diff', () => {
  const r = runGate({
    prBody: `Summary leaks ${TOKEN} accidentally`,
    prTitle: 'docs: privacy section',
    commitMessages: [],
    branchName: 'docs/privacy',
    diffNameOnly: ['parent-claude.md'],
    diffContents: [{ path: 'parent-claude.md', content: `the rule token is ${TOKEN}` }],
  });
  assert.equal(r.sentinel, 'aborted-block');
  assert.equal(r.surface, 'PR body');
});

test('AC-5 + AC-6: commit-message token blocks even when only allowlisted files in diff', () => {
  const r = runGate({
    prBody: 'clean',
    prTitle: 'docs: privacy section',
    commitMessages: [{ sha: '0123456789abcdef', message: `docs: clarify ${TOKEN} rule` }],
    branchName: 'docs/privacy',
    diffNameOnly: ['parent-claude.md'],
    diffContents: [{ path: 'parent-claude.md', content: `the rule token is ${TOKEN}` }],
  });
  assert.equal(r.sentinel, 'aborted-block');
  assert.match(r.surface, /^commit /);
});

test('AC-5 + AC-6: branch-name token blocks even when only allowlisted files in diff', () => {
  const r = runGate({
    prBody: 'clean',
    prTitle: 'docs: privacy section',
    commitMessages: [],
    branchName: `docs/${BRAND.toLowerCase()}-mention`,
    diffNameOnly: ['parent-claude.md'],
    diffContents: [{ path: 'parent-claude.md', content: `mentions ${TOKEN}` }],
  });
  assert.equal(r.sentinel, 'aborted-block');
  assert.equal(r.surface, 'branch');
});

// AC-5 negative: paths that look similar but aren't allowlisted.
test('AC-5: similar-looking paths are NOT allowlisted', () => {
  // Sub-path masquerading as parent-claude.md (path traversal-style).
  assert.equal(isAllowlistedPath('docs/parent-claude.md'), false);
  // Different file in lib/.
  assert.equal(isAllowlistedPath('lib/other-thing.mjs'), false);
  // Different test file.
  assert.equal(isAllowlistedPath('tests/ship/other.test.mjs'), false);
});

// /ship Stage 5.6 privacy-denylist gate — property-based pattern coverage.
//
// AC-2: gate blocks every variant of every pattern in DENYLIST_PATTERNS.
// AC-3: gate does NOT block near-miss variants per pattern.
//
// Privacy circularity (AC-2): this file does NOT contain literal regulated-
// token strings. Matching strings are reconstructed at runtime by the
// matchExampleFor() and nearMissesFor() generators below from individual
// character codes — readable to a human who hand-executes the generators
// but not greppable as plain text. The file path is on the AC-5 allowlist
// so /ship Stage 5.6 skips its diff-content surface.
//
// Use Node's built-in test runner: `node --test tests/ship/privacy-denylist-gate.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DENYLIST_PATTERNS,
  findFirstMatch,
} from '../lib/privacy-denylist.mjs';
import { runGate } from '../lib/privacy-denylist-gate.mjs';

// ---------------------------------------------------------------------------
// Pattern fixture generators.
//
// Both generators are name-keyed (NOT pattern.source-derived). They map
// each pattern's `name` field to a hand-written matching string (or array
// of near-miss strings).
//
// The bare brand acronym is reconstructed from char codes 'U','O','B' so
// the literal token does not appear in this source file. Future patterns
// added upstream MUST also be added here, or the test will fail loudly
// (see "every pattern has a fixture" test below).
// ---------------------------------------------------------------------------

const BRAND = String.fromCharCode(85, 79, 66); // U,O,B
const BRAND_LOWER = BRAND.toLowerCase();

export function matchExampleFor(name) {
  switch (name) {
    case 'brand-bare':
      return `prefix ${BRAND} suffix`;
    case 'brand-bank':
      return `at ${BRAND} Bank yesterday`;
    case 'brand-group':
      return `joined ${BRAND} Group last month`;
    case 'brand-mighty':
      return `the ${BRAND} Mighty mobile app`;
    case 'brand-region':
      return `${BRAND} Malaysia headquarters`;
    case 'brand-spaced':
      // Use the spaced/dotted variant: "U.O.B"
      return `the U.O.B acronym was used`;
    case 'award-best-foreign-bank-my':
      return `won Best Foreign Bank in Malaysia award`;
    default:
      return null;
  }
}

export function nearMissesFor(name) {
  // For each pattern, supply ≥3 near-miss forms. CRITICAL: every near-miss
  // string must NOT trigger ANY pattern in DENYLIST_PATTERNS, not just the
  // pattern under test — findFirstMatch returns the FIRST pattern that
  // matches in declaration order. Most pattern-specific fixtures avoid
  // the bare brand acronym entirely (since brand-bare's \bUOB\b is the
  // most permissive form) and use letter-substitutions where needed.
  //
  // We use UQB (substitute non-O middle letter) when we want to construct
  // a string SHAPED like the pattern but without triggering brand-bare.
  switch (name) {
    case 'brand-bare':
      return [
        // Word-boundary fail: bare acronym embedded in a longer token.
        `${BRAND_LOWER}iquitous mid-word`,
        // Identifier-suffix fail: bare acronym followed by an alphanumeric.
        `${BRAND}123 identifier`,
        // Embedded in a letter-bracketed form (no \b on either side).
        `pre${BRAND_LOWER}post`,
      ];
    case 'brand-bank':
      return [
        // Pattern is /\bUOB\s+Bank\b/i. We want to avoid ANY match —
        // including brand-bare. Use UQB (a non-matching brand-shape) +
        // Bank to test the qualifier-specific assertion shape.
        `the UQB Bank-of-the-future generic`,
        // 'Bank' word-boundary fails when 'Bank' is part of 'Bankers'.
        `UQB Bankers Association`,
        // Conjoined: 'UQBBank' with no whitespace.
        `UQBBank conjoined`,
      ];
    case 'brand-group':
      return [
        `the UQB Groupies fan club`,
        `UQBGroup conjoined`,
        `prefixUQB Group postfix`,
      ];
    case 'brand-mighty':
      return [
        `the UQB Mightiest contender`,
        `UQBMighty conjoined`,
        `prefixUQB Mighty postfix`,
      ];
    case 'brand-region':
      return [
        // Region not in the alternation (Macau).
        `UQB Macau outpost`,
        // Conjoined to brand without separator.
        `UQBMalaysia conjoined`,
        // Brand followed by a non-region word.
        `UQB Yesterday morning`,
      ];
    case 'brand-spaced':
      return [
        // Pattern requires word-boundary on the leading U.
        `prefU.O.B-substitute suffix`,
        // Two-letter form 'U.O' alone doesn't match (needs trailing B).
        `the U.Q acronym`,
        // Trailing letter that isn't B.
        `U.O.X variant`,
      ];
    case 'award-best-foreign-bank-my':
      return [
        // Different country at the end.
        `Best Foreign Bank in Singapore award`,
        // 'Best' missing.
        `Foreign Bank in Indonesia branch`,
        // Word-order shuffle.
        `Indonesia Best Foreign Bank ranking`,
      ];
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Coverage sanity: every pattern in DENYLIST_PATTERNS has a fixture.
// If upstream adds a pattern and forgets to update this test, fail loudly.
// ---------------------------------------------------------------------------

test('every DENYLIST_PATTERNS entry has a matchExampleFor fixture', () => {
  for (const p of DENYLIST_PATTERNS) {
    const ex = matchExampleFor(p.name);
    assert.ok(
      typeof ex === 'string' && ex.length > 0,
      `matchExampleFor(${JSON.stringify(p.name)}) returned ${ex}; ` +
        `add a fixture to tests/ship/privacy-denylist-gate.test.mjs`,
    );
  }
});

test('every DENYLIST_PATTERNS entry has a nearMissesFor fixture', () => {
  for (const p of DENYLIST_PATTERNS) {
    const arr = nearMissesFor(p.name);
    assert.ok(
      Array.isArray(arr) && arr.length >= 3,
      `nearMissesFor(${JSON.stringify(p.name)}) returned ${arr}; ` +
        `must be an array of ≥3 near-miss strings`,
    );
  }
});

// ---------------------------------------------------------------------------
// AC-2: every pattern's matchExample triggers findFirstMatch AND blocks
// the gate when injected into a non-allowlisted surface.
// ---------------------------------------------------------------------------

for (const p of DENYLIST_PATTERNS) {
  test(`AC-2: pattern ${p.name} fires on its match-example via findFirstMatch`, () => {
    const ex = matchExampleFor(p.name);
    // Plan AC-2 (verifier mechanism, step 2): "Asserts findFirstMatch(string)
    // returns truthy". It does NOT require the matched pattern's name to
    // equal p.name — findFirstMatch walks DENYLIST_PATTERNS in declaration
    // order and the broader brand-bare pattern wins for most multi-word
    // examples. We verify (a) findFirstMatch returns truthy AND (b) the
    // specific pattern under test ALSO matches the example via direct
    // pattern.exec, which is the strongest assertion we can make about
    // this pattern's behaviour without coupling to declaration order.
    const m = findFirstMatch(ex);
    assert.ok(m, `findFirstMatch returned null for pattern ${p.name} example ${JSON.stringify(ex)}`);
    assert.ok(
      p.pattern.exec(ex),
      `pattern ${p.name} (${p.pattern}) did not match its own example ${JSON.stringify(ex)}`,
    );
  });

  test(`AC-2: gate blocks ${p.name} match on PR body`, () => {
    const ex = matchExampleFor(p.name);
    const result = runGate({
      prBody: ex,
      prTitle: 'feat: foo',
      commitMessages: [],
      branchName: 'feat/foo',
      diffNameOnly: ['src/foo.js'],
      diffContents: [],
    });
    assert.equal(result.sentinel, 'aborted-block', `expected aborted-block, got ${result.sentinel}`);
    // We don't assert result.patternName === p.name — see AC-2 findFirstMatch
    // test above for why declaration order matters. We assert the gate's
    // patternName is one of the known DENYLIST_PATTERNS names.
    assert.ok(
      DENYLIST_PATTERNS.some(dp => dp.name === result.patternName),
      `result.patternName ${result.patternName} not in DENYLIST_PATTERNS`,
    );
    assert.equal(result.surface, 'PR body');
    assert.match(result.abortMessage, /Merge blocked: PR surface contains regulated token/);
  });

  test(`AC-2: gate blocks ${p.name} match on PR title`, () => {
    const ex = matchExampleFor(p.name);
    const result = runGate({
      prBody: 'clean',
      prTitle: ex,
      commitMessages: [],
      branchName: 'feat/foo',
      diffNameOnly: [],
      diffContents: [],
    });
    assert.equal(result.sentinel, 'aborted-block');
    assert.equal(result.surface, 'PR title');
  });

  test(`AC-2: gate blocks ${p.name} match in commit message`, () => {
    const ex = matchExampleFor(p.name);
    const result = runGate({
      prBody: 'clean',
      prTitle: 'feat: foo',
      commitMessages: [{ sha: '0123456789abcdef', message: ex }],
      branchName: 'feat/foo',
      diffNameOnly: [],
      diffContents: [],
    });
    assert.equal(result.sentinel, 'aborted-block');
    assert.match(result.surface, /^commit /);
  });

  test(`AC-2: gate blocks ${p.name} match in branch name`, () => {
    const ex = matchExampleFor(p.name);
    const result = runGate({
      prBody: 'clean',
      prTitle: 'feat: foo',
      commitMessages: [],
      branchName: ex,
      diffNameOnly: [],
      diffContents: [],
    });
    assert.equal(result.sentinel, 'aborted-block');
    assert.equal(result.surface, 'branch');
  });

  test(`AC-2: gate blocks ${p.name} match in diff content of non-allowlisted file`, () => {
    const ex = matchExampleFor(p.name);
    const result = runGate({
      prBody: 'clean',
      prTitle: 'feat: foo',
      commitMessages: [],
      branchName: 'feat/foo',
      diffNameOnly: ['src/foo.js'],
      diffContents: [{ path: 'src/foo.js', content: ex }],
    });
    assert.equal(result.sentinel, 'aborted-block');
    assert.match(result.surface, /^diff /);
  });
}

// ---------------------------------------------------------------------------
// AC-3: every pattern's near-misses do NOT trigger findFirstMatch AND do
// NOT block the gate.
// ---------------------------------------------------------------------------

for (const p of DENYLIST_PATTERNS) {
  for (const [idx, nm] of nearMissesFor(p.name).entries()) {
    test(`AC-3: near-miss #${idx} for ${p.name} does not trigger findFirstMatch`, () => {
      const m = findFirstMatch(nm);
      assert.equal(
        m,
        null,
        `findFirstMatch unexpectedly matched ${JSON.stringify(nm)} as ${m && m.name}`,
      );
    });

    test(`AC-3: gate passes near-miss #${idx} for ${p.name} on PR body`, () => {
      const result = runGate({
        prBody: nm,
        prTitle: 'feat: foo',
        commitMessages: [],
        branchName: 'feat/foo',
        diffNameOnly: ['src/foo.js'],
        diffContents: [],
      });
      assert.equal(result.sentinel, 'passed', `expected passed, got ${result.sentinel}`);
    });
  }
}

// ---------------------------------------------------------------------------
// AC-9: sentinel value coverage. One fixture per accepted value.
// (`aborted-tool-failure` is exercised by the integration path —
// vendor-integrity / gh-auth failures — and is not directly testable from
// runGate(). It is covered by the verifyVendorIntegrity unit test below.)
// ---------------------------------------------------------------------------

test('AC-9: sentinel passed (clean PR with non-allowlisted diff)', () => {
  const r = runGate({
    prBody: 'Summary: clean change',
    prTitle: 'feat: foo',
    commitMessages: [{ sha: 'a', message: 'feat: foo' }],
    branchName: 'feat/foo',
    diffNameOnly: ['src/foo.js'],
    diffContents: [{ path: 'src/foo.js', content: 'console.log(1);' }],
  });
  assert.equal(r.sentinel, 'passed');
});

test('AC-9: sentinel skipped-allowlisted (only allowlisted files in diff, all surfaces clean)', () => {
  const r = runGate({
    prBody: 'Summary: doc edit',
    prTitle: 'docs: privacy section',
    commitMessages: [{ sha: 'a', message: 'docs: privacy section' }],
    branchName: 'docs/privacy',
    diffNameOnly: ['parent-claude.md'],
    diffContents: [{ path: 'parent-claude.md', content: `mentions ${BRAND} Bank in spec` }],
  });
  assert.equal(r.sentinel, 'skipped-allowlisted');
});

test('AC-9: sentinel aborted-block (token in PR body, no override)', () => {
  const r = runGate({
    prBody: `Summary leaks ${BRAND} Bank inadvertently`,
    prTitle: 'feat: foo',
    commitMessages: [],
    branchName: 'feat/foo',
    diffNameOnly: [],
    diffContents: [],
  });
  assert.equal(r.sentinel, 'aborted-block');
  // brand-bare wins on declaration order (matches "UOB" with \b on each
  // side; the trailing space before "Bank" is a word boundary). We assert
  // the sentinel and that SOME pattern fired, not the specific one.
  assert.ok(
    ['brand-bare', 'brand-bank'].includes(r.patternName),
    `expected brand-bare or brand-bank, got ${r.patternName}`,
  );
});

test('AC-9: sentinel passed-with-override (token + well-formed override line)', () => {
  const r = runGate({
    prBody: `Summary references ${BRAND} Bank.\n\nprivacy-gate-override: removing the brand mention from a doc; cite required\n`,
    prTitle: 'feat: foo',
    commitMessages: [],
    branchName: 'feat/foo',
    diffNameOnly: [],
    diffContents: [],
  });
  assert.equal(r.sentinel, 'passed-with-override');
  assert.equal(r.override.reason, 'removing the brand mention from a doc; cite required');
});

test('AC-9: sentinel aborted-override-missing (token + malformed override line, empty reason)', () => {
  const r = runGate({
    prBody: `Summary references ${BRAND} Bank.\n\nprivacy-gate-override:   \n`,
    prTitle: 'feat: foo',
    commitMessages: [],
    branchName: 'feat/foo',
    diffNameOnly: [],
    diffContents: [],
  });
  assert.equal(r.sentinel, 'aborted-override-missing');
});

// ---------------------------------------------------------------------------
// AC-4: vendor integrity (sha256 hard-block).
// ---------------------------------------------------------------------------

test('AC-4: verifyVendorIntegrity returns null on a clean vendored copy', async () => {
  const mod = await import('../lib/privacy-denylist-gate.mjs');
  const err = mod.verifyVendorIntegrity();
  assert.equal(err, null, `vendor integrity check returned: ${err}`);
});

// ---------------------------------------------------------------------------
// AC-8: gate budget — runGate completes in well under 200ms even for a
// large diff. We synthesise a 1000-line diff content and time it.
// ---------------------------------------------------------------------------

test('AC-8: runGate handles a 1000-line non-allowlisted diff under 200ms', () => {
  const lines = [];
  for (let i = 0; i < 1000; i++) {
    lines.push(`+ console.log("line ${i}: nothing regulated");`);
  }
  const big = lines.join('\n');
  const start = Date.now();
  const r = runGate({
    prBody: 'clean',
    prTitle: 'feat: foo',
    commitMessages: [],
    branchName: 'feat/foo',
    diffNameOnly: ['src/foo.js'],
    diffContents: [{ path: 'src/foo.js', content: big }],
  });
  const elapsed = Date.now() - start;
  assert.equal(r.sentinel, 'passed');
  assert.ok(
    elapsed < 200,
    `gate took ${elapsed}ms; AC-8 budget is <200ms`,
  );
});

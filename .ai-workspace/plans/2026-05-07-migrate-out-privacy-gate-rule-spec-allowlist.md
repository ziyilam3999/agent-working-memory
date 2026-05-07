# migrate-out — privacy-gate rule-spec allowlist (mirror ai-brain Stage 5.6)

## ELI5

Today we tried to move 97 Windows-side memory cards to macbook via `memory migrate-out`. It refused because two cards (`topics/privacy/no-employer-brand.md` and `topics/privacy/no-linkedin-on-github.md`) contain the regulated employer-brand token "UOB". 

That's expected — those cards INTENTIONALLY carry the token, because they ARE the rules that say "don't write UOB anywhere else." Per parent-claude.md's privacy spec: "rule-spec files (the privacy card + per-project `feedback_no_employer_mention.md`) intentionally carry the token; no other file is exempt."

The migrate-out CLI doesn't know about that exemption. It does the right thing for every other card, but it false-blocks on the rule-spec cards.

The fix: small allowlist of file paths whose privacy check is skipped. Mirrors the pattern that ai-brain's `/ship` Stage 5.6 just adopted in v0.50.0 (vendor-with-provenance allowlist for in-repo content).

## Cairn lookup

Topic: privacy-gate-allowlist

1. tier-b/topics/migration/2026-05-07-memory-portability-arc-fully-shipped.md — yesterday's arc card; v0.50.0 = ai-brain Stage 5.6 privacy-denylist gate (pattern to mirror)
2. tier-b/topics/privacy/no-employer-brand.md — the authoritative rule-spec card whose intentional regulated-token presence forces this work (the file IS the rule)
3. parent-claude.md "Privacy & Employer-Brand Hygiene" — "rule-spec exemption" clause — the canonical authority for the allowlist

## Context

We need migrate-out to push Windows-side cards to macbook before Windows decommissions. The current state:

- macbook has 305 cards (post-AC-3 PASS this session); content-sync from macbook → backup repo is one-way, so Windows-only cards never reach macbook via content-sync.
- migrate-out is the bridge: bundle Windows-side delta into a `migration/<host>-<date>` branch; macbook then `migrate-in` from it.
- migrate-out has a privacy gate (`scripts/lib/privacy-denylist.mjs`) that scans every card for regulated tokens. Per AC-9b of the original migrate-in/out plan, gate is hard-block — refuses to push on any match.
- Two `topics/privacy/*.md` rule-spec cards LEGITIMATELY carry "UOB" because they document the very rule that bans the token. parent-claude.md's privacy spec carves them out as the only exemption.
- migrate-out doesn't know about the carve-out; treats them like any other card. Result: every migrate-out from this host blocks until those cards are removed (which they shouldn't be — they're the rule).

This blocks not just today's drain — every future migrate-out on any host that has the rule-spec cards (which is every host, since those cards are universal). The bug applies to macbook → backup migrations too if macbook ever runs migrate-out.

## Goal

`memory migrate-out --dry-run` from a host that has the rule-spec privacy cards on disk completes without `PRIVACY-BLOCK` for those specific cards, while still blocking ANY OTHER card that contains the regulated token. The allowlist is hardcoded (not user-supplied) so it can't be abused.

## Binary AC

- **AC-1: rule-spec allowlist enforced.** `scripts/lib/privacy-denylist.mjs` exports a frozen set `RULE_SPEC_ALLOWLIST` containing exactly two relative paths: `topics/privacy/no-employer-brand.md`, `topics/privacy/no-linkedin-on-github.md`. The set is exported alongside `findFirstMatch` / `findAllMatches`. No other paths are allowlisted.

  Verifier: `node -e "import('./scripts/lib/privacy-denylist.mjs').then(m => console.log([...m.RULE_SPEC_ALLOWLIST].sort().join('\n')))"` outputs exactly the two paths above (sorted).

- **AC-2: migrate-out skips allowlisted files.** `scripts/migrate-out.mjs` consults `RULE_SPEC_ALLOWLIST` before calling `findFirstMatch` per card. If `card.relPath` is in the allowlist, the card is admitted without privacy scan. All other cards are scanned as before.

  Verifier: with the rule-spec cards present on disk + a third card containing "UOB" that is NOT in the allowlist, `migrate-out --dry-run --verbose` exits non-zero AND the rejection mentions ONLY the third card (not the two allowlisted ones).

- **AC-3: real-world drain works on Windows.** From the current Windows host (97 pinned cards in delta, two rule-spec cards present), `memory migrate-out --dry-run --verbose` completes and prints the would-push card list without `PRIVACY-BLOCK`. After ship: `memory migrate-out` (no --dry-run) creates branch `migration/<host-id>-2026-05-07` on `agent-working-memory-content` containing the delta.

  Verifier: post-ship, run `memory migrate-out` from Windows; assert exit 0 AND the new migration branch is visible via `git ls-remote --heads <content-remote> 'migration/*'` AND `git ls-tree -r <branch> -- 'tier-b/topics/'` shows ≥95 cards.

- **AC-4: hostile-input regression test (with fixture-circularity guard).** Test fixture: a fake card at a non-allowlisted path containing the regulated token still trips the privacy gate. Test fixture: a card AT one of the allowlisted paths still triggers privacy match in `findFirstMatch` (so the underlying scanner isn't accidentally weakened) but is NOT rejected by migrate-out.

  **Fixture-circularity guard (same lesson ai-brain hit in Stage 5.6 pre-compact card 2026-05-06):** the test file MUST NOT contain the regulated token as a contiguous source-level string — otherwise the test file IS itself the leak the gate exists to catch (and would trip a future cross-repo scan). Solution: build the regulated test string at runtime via concatenation or `String.fromCharCode` (e.g., `"U" + "O" + "B"`, `Buffer.from([85,79,66]).toString()`). The DENYLIST_PATTERNS regex still matches the runtime-built string, but `git grep UOB tests/` in the agent-working-memory repo returns zero hits.

  Verifier: (a) test runner exits 0 with the new test cases; (b) `git grep -nE 'UOB|U\.O\.B|Best Foreign Bank' tests/` returns zero hits AFTER the test file lands.

- **AC-5: allowlist is path-pinned, not glob-pinned.** `RULE_SPEC_ALLOWLIST` uses exact-string equality — no `topics/privacy/*` wildcards. This prevents a future card under `topics/privacy/` (e.g., a newly-written rule that doesn't actually need the regulated token) from sneaking past the gate.

  Verifier: a hypothetical fixture card at `topics/privacy/some-other-card.md` containing "UOB" SHOULD be rejected (because it's not in the literal allowlist). Test asserts this.

- **AC-6: macOS portability.** All AC-1 through AC-5 verifiers pass when the test suite runs under macOS bash 3.2 (already a CI gate via `bash-3.2-lint.yml` — no new portability surface added by this change since it's pure ES module code).

  Verifier: PR CI's bash-3.2-lint job exits 0; `node` test suite exits 0 on the macOS CI runner if one exists, or via macbook session smoke as belt-and-braces.

## Out of scope

- **Generalizing to per-project allowlist files.** ai-brain's Stage 5.6 has a more elaborate vendor-with-provenance allowlist with sha256 hashes and time-pinned vendoring. migrate-out's allowlist is a 2-entry set — sha256 + provenance is overkill. If a future card needs allowlisting, file a follow-up that adds it explicitly.
- **Override flag (`--skip-privacy-gate`).** Considered but rejected: an explicit override flag exists to handle this OUTSIDE the allowlist surface. The allowlist is hardcoded specifically so individual operators can't bypass the gate. parent-claude.md's privacy rule is HARD-class, not soft-class.
- **Surface beyond migrate-out.** The gate currently only fires on migrate-out. A future plan can wire it into other surfaces (commit hook on the content repo? content-sync?). Out of scope for this fix.
- **Renaming privacy-denylist.mjs.** Module name stays. Adding the export doesn't justify a rename.

## Verification procedure

1. Implement allowlist + migrate-out skip + tests.
2. Run AC-1 + AC-2 + AC-4 + AC-5 verifiers locally on Windows pre-push.
3. Ship to PR; CI runs bash-3.2-lint + test suite (AC-6).
4. Post-ship, run AC-3 on Windows (real-world migrate-out — actual push).
5. macbook then runs `memory migrate-in --from-branch migration/<host-id>-2026-05-07` to consume the migration; sends ack back.

## Critical files

- `scripts/lib/privacy-denylist.mjs` — add `RULE_SPEC_ALLOWLIST` frozen set.
- `scripts/migrate-out.mjs` — allowlist consult before `findFirstMatch` call (line ~189 currently).
- `tests/migrate.test.mjs` — add 3 new test cases (allowlisted path admitted, non-allowlisted path with token rejected, hypothetical sibling rule-spec path rejected).
- (Doc) parent-claude.md note: optional — link the migrate-out allowlist as the "this is where the rule-spec exemption lives mechanically." Stretch, only if trivial.

## Out-of-scope follow-ups (not part of this plan)

- After migrate-out succeeds, macbook needs to run migrate-in from the new branch. That's a manual mailbox round-trip, not code.
- If migrate-out grows more allowlist needs (>5 entries), revisit whether the hardcoded set should become a JSON manifest. Not now.

## Checkpoint

When AC-3 passes (real Windows migrate-out succeeds + macbook migrate-in succeeds), task closes. The Windows-side knowledge drain pipeline is fully functional, not just the macbook-side bootstrap.

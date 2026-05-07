# Fix: prefer-newer-commit silent-degenerate when tier-b is not a git repo

> **Intent (one-line north star):** Make `prefer-newer-commit` use real timestamps for local cards in a non-git tier-b root, so a freshly-edited remote card actually wins over a stale local copy on round-trip migrate-in.

## ELI5

The migrate-in CLI has a flag called `--strategy prefer-newer-commit`. The promise is: "if the same card exists on both your computer and the migration branch, the version with the newer commit time wins." Useful for round-trip drains where two hosts both edit and you want the latest one.

Bug: on a normal user machine, the runtime tier-b folder (`~/.claude/agent-working-memory/tier-b/`) is just plain files in your home directory — it's not a git repo. The CLI tries to look up "when was this local file last committed?" via `git log`, fails because there's no git repo, and falls back to "Infinity" (which means "infinitely new"). So the local copy ALWAYS wins, regardless of whether the remote has a brand-new edit.

Concrete consequence on macbook today: every one of 309 cards showed `local-ct=Infinity` in the verbose output. None of those comparisons would have caught a legitimately-newer remote edit. Today the 4 cards that wrote did so via `add-from-remote` (local was missing entirely, no comparison), so nothing was masked. But the next round-trip drain where a card has been edited on both sides would silently lose the remote edit.

Fix in plain English: when the local file isn't in any git repo, use the file's **modification time** (when it was last touched on disk) as a stand-in for "commit time." During migrate-in's copy step, also set the new local file's mtime to match the source commit's committed-date so the round-trip stays consistent.

## Goal

Replace the `Infinity` fallback in `getFileCommitTime` with a filesystem-mtime fallback when the path is genuinely outside any git repo. Pair with a copy-time mtime stamp in `runMigrateIn` so just-copied local cards have an mtime that equals the source remote commit's committed-date.

**Relationship to AC-6b (intentional behavior change).** The original AC-6b in `migration-bundle.mjs:127-131` says: "untracked-local-card always wins over a remote-tracked one under prefer-newer-commit." That mechanic was implemented as Infinity-wins. The original *intent* was "prefer the user's freshest local edit over an old remote." On a tier-b root that is not a git repo (the production shape), every local card is "untracked" forever — so the implementation always picks local regardless of actual freshness, which violates the intent.

This fix **evolves AC-6b's implementation while preserving its intent**: a local card with a real, recent mtime still wins over an older remote commit (same intent), but a local card whose mtime is older than a fresh remote edit now correctly loses (intent now actually fires). The local-only branch (`onLocal && !onRemote`) is unchanged — it still keep-locals via `planMerge`'s short-circuit, never entering strategy resolution.

## Execution model

**Inline implementation in this session, single-PR ship.** Rationale:

- Touches 3 files in 1 repo (`scripts/lib/migration-bundle.mjs`, `scripts/migrate-in.mjs`, `tests/migrate.test.mjs`) — under the 3+ file delegate-bar, but at the edge of it.
- Changes are small and tightly coupled (~20 LoC across the two source files + ~4 new test cases). No architectural decision; the design is forced by the code shape (already documented in `findLocalGitRoot` comments referencing AC 6b).
- Tests already exist as a fixture pattern; new cases extend the existing structure rather than introducing a new harness.
- A subagent handoff would add overhead with no parallelism gain (single bundle, single repo, no disjoint write surfaces).
- Plan-First-Workflow's filed-plan + ELI5 + binary AC + Anson approval gate fully apply before code lands. /coherent-plan review runs in a background subagent before showing ELI5 to user (per Rule 2: sequential ≠ foreground for chained reviewers).

If the implementation surfaces unexpected complexity (e.g. mtime resolution issues forcing a sidecar manifest after all), STOP and re-plan rather than push through (Rule 1 mid-flight failure → re-plan).

## Out of scope

- Lane B (doc-only on the existing degenerate behavior) — superseded by Lane A.
- Lane C (new `prefer-remote` strategy) — separate workflow ask; defer until a real use case.
- Migrating tier-b into a git repo (heavy, changes user-facing semantics).
- Sidecar manifest tracking last-known-remote-ct per card. Mtime is sufficient because: (a) migrate-in stamps mtime to source commit's committed-date during copy, so the local stays aligned with last successful drain; (b) user edits via editor naturally update mtime to current-time, which beats any older remote commit; (c) no second source of truth to keep in sync.
- Changes to migrate-out (only migrate-in's strategy resolution changes here).

## Critical files

| File | What changes |
|---|---|
| `scripts/lib/migration-bundle.mjs` | `getFileCommitTime`: when not in a git repo, return filesystem mtime in seconds instead of Infinity. AC 6b semantic preserved by `planMerge`'s short-circuit (no edit needed there). |
| `scripts/migrate-in.mjs` | `runMigrateIn` step 5 (execute): after `copyFileSync(src, dest)`, call `utimesSync(dest, atime, mtime_from_source_commit)` so subsequent migrate-ins see honest local-ct values. |
| `tests/migrate.test.mjs` | New cases: (a) round-trip migrate-in with no remote change → all decisions resolve to keep-local with finite local-ct (NOT Infinity); (b) remote-edited-after-local-copy → remote wins via copy-from-remote; (c) AC 6b regression — local-only card still wins (planMerge short-circuit, never enters strategy). |

## Binary AC (verifiable from outside the diff)

- **AC-1** Round-trip honesty (BLOCKER): a fresh `migrate-in --from-branch X --strategy prefer-newer-commit --dry-run --verbose` followed immediately by an identical second invocation produces verbose output where every `keep-local` line shows `local-ct=<finite-integer>` (not `Infinity`) for cards that exist on both sides. Verifier:
  ```bash
  cd ~/coding_projects/agent-working-memory
  node src/memory-cli.mjs migrate-in --from-branch main --strategy prefer-newer-commit --dry-run --verbose 2>&1 \
    | grep -E '^keep-local.*local-ct=' \
    | awk -F'local-ct=' '{ split($2, a, " "); if (a[1] == "Infinity") print "FAIL:", $0; else print "OK" }' \
    | grep -c FAIL
  # Expect: 0. Any non-zero count is a regression — the Infinity fallback is leaking back into the both-exist comparison path.
  ```

- **AC-2** Remote-newer-wins (BLOCKER): with a tier-b card pre-staged at `committed_date=T1`, then the same card committed-newer on the migration branch at `T2 > T1`, `migrate-in --strategy prefer-newer-commit` (NOT dry-run) overwrites the local card. Test in `tests/migrate.test.mjs`:
  ```javascript
  // Setup tmpfs tier-b at T1 (utime stamped), remote branch with same path at T2 > T1.
  // Run runMigrateIn({ strategy: 'prefer-newer-commit' }).
  // Expect: decisions includes { action: 'copy-from-remote', reason: matches /local-ct=T1.*remote-ct=T2/ }.
  // Expect: file content on disk now equals remote's content.
  ```

- **AC-3** Local-only short-circuit preserved (BLOCKER): a local-only card (no remote counterpart) still keeps-local via `planMerge`'s short-circuit, never entering strategy resolution. This guards the unchanged branch — distinct from AC-6b's both-exist case which IS being intentionally changed. Test:
  ```javascript
  // Setup tier-b with a card not present on remote branch.
  // Run runMigrateIn({ strategy: 'prefer-newer-commit', dryRun: true }).
  // Expect: decisions includes { action: 'keep-local', reason: 'remote-missing' }.
  // Expect: never enters resolveStrategy for this path (resolveStrategy spy assertion).
  ```

- **AC-4** Copy-step mtime stamp: after `runMigrateIn` copies a file from a remote commit at epoch T2, the local file's mtime matches T2 within ±1s tolerance. Test assertion: `Math.abs(statSync(localPath).mtimeMs / 1000 - T2) <= 1`. (Strict `===` would be brittle against APFS sub-second precision — see R2.)

- **AC-5** Honesty under mixed-decision migrate-in: when migrate-in writes both `add-from-remote` AND `copy-from-remote` cards in one run, both have correct mtime stamps post-copy. Test in `tests/migrate.test.mjs`.

- **AC-6** Existing tests still pass: `node --test tests/` reports same baseline pass count as pre-fix master (no regressions in migrate-out, hygiene, or other paths).

## Risks + mitigations

- **R1 — User-edited-but-not-saved-with-new-mtime cards**: if a user runs `git checkout HEAD -- some-card.md` from a clone, mtime may be the checkout time, not the original commit time. Today this is non-issue because runtime tier-b isn't checked out from a git repo — it only gets writes from migrate-in (mtime-stamped) or from the user's editor (real mtime). Mitigation: documented assumption + AC-4 covers the migrate-in stamp path.

- **R2 — Filesystem mtime resolution on macOS HFS+/APFS**: HFS+ has 1-second mtime resolution; APFS has 1-nanosecond. If two operations happen within the same second on HFS+, comparison could be a tie. Mitigation: use `>=` not `>` in resolveStrategy (already does this — `localCommitTime >= remoteCommitTime ? "local" : "remote"`). Tie → local wins, which is the conservative no-op outcome.

- **R3 — Time-zone or NTP drift on user machine vs. remote commit**: remote commit times come from the committer's clock (push side). Local mtime comes from local clock at copy time. If clocks disagree, tie-breaker bias could matter. Mitigation: AC-4 stamps local mtime to *remote's* committed-date, not local clock-at-copy-time, so both ends use the same authority for the comparison.

## Rollback

If the fix breaks downstream (e.g. surprising behavior on a tier-b inside a git working tree), revert the two-line change in `getFileCommitTime` and the utimesSync call in `runMigrateIn`. Tests in `tests/migrate.test.mjs` are additive — no need to revert them, they continue to pass against the reverted code in their AC-3 form (AC-1, AC-2, AC-4, AC-5 will fail as expected, signaling regression).

## Verification

| Check | How |
|---|---|
| AC-1 round-trip honesty | Run the dry-run pipe shown above; expect 0 FAIL |
| AC-2 remote-newer-wins | `node --test tests/migrate.test.mjs` |
| AC-3 AC-6b preserved | Same test file |
| AC-4 mtime stamp | Same test file |
| AC-5 mixed-decision honesty | Same test file |
| AC-6 baseline regression | `node --test tests/` from repo root, compare pass count vs `git show HEAD~1:tests/...` |

## Pickup pointer if interrupted

- Discovery mail (archived): `mailbox/archive/2026-05-07T1115-macbook-session-to-wise-grace-windows-drain-migrate-in-pass-with-flag.md`
- Handoff mail (archived): `mailbox/archive/2026-05-07T1130-wise-grace-to-macbook-session-handoff-prefer-newer-commit-fix.md`
- Bug location: `scripts/lib/migration-bundle.mjs:133-148` (the catch returning Infinity), `scripts/migrate-in.mjs:326-336` (the copy step needing utimesSync)
- Test file: `tests/migrate.test.mjs` (existing, add cases here)

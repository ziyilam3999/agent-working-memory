# Adopt /ship Stage 5.6 mechanical privacy gate in agent-working-memory

> **Intent (one-line north star):** Make /ship Stage 5.6 actually fire on agent-working-memory PRs by committing the gate runner + a self-pointing provenance, so privacy leaks are caught mechanically (P6/P13, ~90-100% compliance) instead of by manual cold-eyes review (F2, ~17% compliance).

## ELI5

`/ship` (the global PR-merge pipeline) has a step called Stage 5.6. It scans 5 surfaces of every PR — body, title, commit messages, branch name, diff content — for the regulated employer-brand token. If it finds one, the merge is blocked. This catches the "I accidentally pasted UOB into a plan file" class of mistake automatically.

For Stage 5.6 to fire, /ship looks for a script at `<repo>/lib/privacy-denylist-gate.mjs`. ai-brain has it. agent-working-memory does NOT — so today's PR #28 ship card showed `privacyDenylistGate: n/a-not-installed` and the gate skipped. Three plan-file leaks of the regulated token went uncaught by mechanism and were caught only by the executor's manual judgment during PR #28 ship review.

Fix: copy ai-brain's gate scaffolding into agent-working-memory's `lib/` directory. Three new files:

1. `lib/privacy-denylist.mjs` — vendored byte-for-byte from `scripts/lib/privacy-denylist.mjs` (same repo's source).
2. `lib/privacy-denylist.provenance.json` — provenance pointing at the in-repo source (self-vendoring), with current sha256.
3. `lib/privacy-denylist-gate.mjs` — copied from ai-brain unchanged (485 LoC), except for one allowlist addition (`scripts/lib/privacy-denylist.mjs`) so editing the source itself doesn't self-block.

Plus tests adapted from ai-brain's `tests/ship/privacy-denylist-gate*.test.mjs` (110 tests).

## Goal

After this ships, `/ship` Stage 5.6 fires on every agent-working-memory PR with the same five-surface gate ai-brain has. PR #28's "3 plan-file leaks caught by judgment" failure mode becomes mechanically impossible: any such leak would set Stage 5.6's sentinel to `aborted-block` and refuse the merge.

The repo becomes its own first-vendoring-consumer of `privacy-denylist.mjs`. This is a deliberate self-reference — agent-working-memory IS the source, but `/ship` Stage 5.6's contract requires the gate at `lib/privacy-denylist-gate.mjs` (hardcoded path). Vendoring the source into `lib/` mirrors ai-brain's shape and keeps the gate's existing import (`./privacy-denylist.mjs`) unchanged.

## Execution model

**Inline implementation in this session, single-PR ship.** Rationale:

- Touches 3 new files in `lib/` + 2 new test files + 1 ALLOWLIST_GLOBS line in the vendored gate. No architectural decision; the contract is set by /ship Stage 5.6's hardcoded path/import.
- Bulk of the code is byte-for-byte vendoring (485 LoC gate + ~110 LoC tests, all from ai-brain). Net new logic ~5 lines.
- Existing tests already cover the gate's behaviour in ai-brain (10 PASS / 0 FAIL). The "adopt verbatim" path means I'm reusing that test coverage — a subagent handoff would just duplicate effort.
- Single-bundle change in one repo, no parallelism gain from /auto-flow. /coherent-plan runs as the only review.
- Plan-First-Workflow + ELI5 + Rule 15 wait gate fully apply before code lands.

If integrity-check semantics surface a complication (the self-vendoring pattern hits an edge case where the gate refuses to run because of provenance shape), STOP and re-plan rather than push through.

## Out of scope

- **Shape B (pre-push git hook)** — defer until Shape A is in production and we observe whether non-/ship pushes need separate gating. /ship Stage 5.6 is the documented mechanism; pushing outside /ship is rare.
- **Adapting the gate to import from `scripts/lib/`** instead of vendoring — would diverge from ai-brain's shape unnecessarily. The cost of one duplicate file in `lib/` is small; the benefit of shape-parity (same allowlist regexes, same provenance check, same audit log entries) is large.
- **Changing the source `scripts/lib/privacy-denylist.mjs`** — not touched. The vendored copy starts byte-equal.
- **Test surface beyond ai-brain's 110-test coverage** — the gate's behaviour is identical to ai-brain's, so ai-brain's tests cover correctness. agent-working-memory adds a single self-vendor sanity test (provenance points at the right path; sha256 matches).
- **Regenerating ai-brain's vendored copy** — this PR doesn't touch ai-brain. ai-brain's vendor stays at its current commit (`88b71434`).

## Critical files

| File | Provenance | Status |
|---|---|---|
| `lib/privacy-denylist.mjs` | Byte-equal copy of `scripts/lib/privacy-denylist.mjs` | NEW (vendored — same repo, self-reference) |
| `lib/privacy-denylist.provenance.json` | Self-referencing provenance: `upstream_repo` = this repo, `upstream_commit` = HEAD before this PR, `upstream_path` = `scripts/lib/privacy-denylist.mjs`, `sha256` = sha256 of the source | NEW |
| `lib/privacy-denylist-gate.mjs` | Byte-equal copy from `ai-brain/lib/privacy-denylist-gate.mjs` | NEW |
| Gate's `ALLOWLIST_GLOBS` | Add `scripts/lib/privacy-denylist.mjs` to the existing 6-entry list | 1 LINE EDIT in the vendored gate |
| `tests/privacy-denylist-gate.test.mjs` | Adapted from `ai-brain/tests/ship/privacy-denylist-gate.test.mjs` — same imports, repo-root-relative paths reused | NEW |
| `tests/privacy-denylist-gate-allowlist.test.mjs` | Adapted from `ai-brain/tests/ship/privacy-denylist-gate-allowlist.test.mjs` | NEW |

## Binary AC (verifiable from outside the diff)

- **AC-1 Gate present at canonical path (BLOCKER):** `test -f lib/privacy-denylist-gate.mjs && test -f lib/privacy-denylist.mjs && test -f lib/privacy-denylist.provenance.json` — all three exit 0.
- **AC-2 Provenance integrity (BLOCKER):**
  ```bash
  node -e '
    import("crypto").then(({createHash}) => {
      import("fs").then(({readFileSync}) => {
        const expected = JSON.parse(readFileSync("lib/privacy-denylist.provenance.json", "utf8")).sha256;
        const actual = createHash("sha256").update(readFileSync("lib/privacy-denylist.mjs")).digest("hex");
        if (actual !== expected) { console.error("MISMATCH:", actual, "vs", expected); process.exit(1); }
        console.log("MATCH");
      });
    });
  '
  ```
  Expect: `MATCH`.
- **AC-3 Self-vendor sanity (BLOCKER):** `lib/privacy-denylist.mjs` and `scripts/lib/privacy-denylist.mjs` are byte-equal: `diff lib/privacy-denylist.mjs scripts/lib/privacy-denylist.mjs` exits 0 with empty output.
- **AC-4 Allowlist includes source path (BLOCKER):** `grep -F "scripts/lib/privacy-denylist.mjs" lib/privacy-denylist-gate.mjs` returns exactly 1 line. (Verifies the allowlist addition is in the gate code, so editing the source doesn't self-block diff-content surface.)
- **AC-5 Gate fires green on this PR's own surfaces (BLOCKER, post-PR-create):** Once the PR is created (after `gh pr create` succeeds), run:
  ```bash
  node lib/privacy-denylist-gate.mjs run --pr-number {THIS_PR}
  ```
  Expect: exit 0 with sentinel in `{passed | skipped-allowlisted}`. NOT `aborted-block` / `aborted-tool-failure`. The chicken-and-egg here mirrors ai-brain's Stage 5.6 self-test (PR #737, line 366 of `~/.claude/skills/ship/SKILL.md`): the PR must exist before the gate can scan its 5 surfaces, but the gate is part of the PR. The plan's prose, plan filename, and PR body MUST avoid the literal regulated token (use `<bare-token>` / "regulated brand" abstractions only) so the non-allowlisted surfaces stay clean.
- **AC-6 Existing tests still pass + new tests pass:** `node --test tests/*.test.mjs` reports at minimum the pre-PR baseline (59/59 from v0.4.0) + the 110 new gate tests transferred from ai-brain's `tests/ship/privacy-denylist-gate*.test.mjs`. Expected total: ~169 pass, 0 fail. If the test transfer surfaces compatibility issues (different test path expectations, etc.), repair them inline rather than deferring.
- **AC-7 Stage 5.6 fires on next merged /ship (POST-MERGE, observed in next session):** the next /ship cycle in agent-working-memory AFTER this PR records `privacyDenylistGate: passed` (or `skipped-allowlisted`) in its run record. Verifier (cannot run during this PR's ship — runs on the SUBSEQUENT PR's ship-card landing in tier-b):
  ```bash
  ls ~/.claude/agent-working-memory/tier-b/topics/ship-runs/ \
    | grep "$(date -u +%Y-%m-)" | tail -1 \
    | xargs -I {} grep privacyDenylistGate ~/.claude/agent-working-memory/tier-b/topics/ship-runs/{}
  ```
  Expect: non-`n/a-not-installed` value. AC-7 is the production-evidence gate — it answers "did Stage 5.6 actually fire end-to-end through /ship," distinct from AC-5 which only verifies the gate script can be invoked.

## Risks + mitigations

- **R1 — Self-vendor is unusual:** ai-brain vendors from agent-working-memory; agent-working-memory now vendors from itself. The provenance shape might confuse a future operator. Mitigation: the provenance JSON's `upstream_repo` field explicitly says `https://github.com/ziyilam3999/agent-working-memory.git` (self) with a comment-style note in the file documenting the self-vendor pattern.
- **R2 — Source drift inside the same repo:** if a future PR edits `scripts/lib/privacy-denylist.mjs` without re-vendoring `lib/privacy-denylist.mjs`, the integrity check fires `aborted-tool-failure`. Mitigation: this is the intended behavior — it's a load-bearing reminder to update both. Document the re-vendor command in `lib/privacy-denylist.provenance.json` as a one-liner comment field.
- **R3 — `gh pr diff` inclusion:** the new `lib/privacy-denylist*` files appear in this PR's diff. The gate scans diff content, but those paths are in `ALLOWLIST_GLOBS` for diff-content. Mitigation: AC-5 directly tests this by running the gate against the PR. If the allowlist works, the gate self-skip-allowlists those files.
- **R4 — Test path divergence:** ai-brain has tests at `tests/ship/`. agent-working-memory has tests at `tests/`. The gate's allowlist for tests references `tests/ship/privacy-denylist-gate*.test.mjs` — these paths don't exist in agent-working-memory. Mitigation: add `tests/privacy-denylist-gate*.test.mjs` to the gate's `ALLOWLIST_GLOBS` so the new test files (which themselves contain runtime-built regulated-token strings) don't self-block.
- **R5 — Empty-stranded /ship pipeline:** if /ship's invocation `node lib/privacy-denylist-gate.mjs run --pr-number {N}` fails because the script is missing in older PRs (rebases, branch-from-old-master), the gate aborts as `aborted-tool-failure`. Mitigation: post-merge, all future PRs branched from master will have the gate. Pre-existing branches that get rebased will pick it up automatically; pre-existing branches that don't rebase will hit `aborted-tool-failure` until they pull master.

## Rollback

If Stage 5.6 unexpectedly blocks a legitimate PR or surfaces a bug: `mv lib/privacy-denylist*.* .ai-workspace/_quarantine-stage-5-6-rollback-YYYY-MM-DD/` and `mv tests/privacy-denylist-gate*.test.mjs .ai-workspace/_quarantine-stage-5-6-rollback-YYYY-MM-DD/`. /ship's gate-discovery falls back to `n/a-not-installed` (or skip with non-blocking warning), restoring pre-PR behaviour. Reversible by `mv` back per Rule 14.

## Verification

| Check | How |
|---|---|
| AC-1 path presence | Three `test -f` calls; all exit 0 |
| AC-2 provenance integrity | Inline node script computing sha256 vs provenance |
| AC-3 byte-equality with source | `diff lib/privacy-denylist.mjs scripts/lib/privacy-denylist.mjs` exits 0 |
| AC-4 allowlist coverage | `grep -F` returns exactly 1 line |
| AC-5 gate self-PASS | `node lib/privacy-denylist-gate.mjs run --pr-number {THIS_PR}` exits 0 with PASS sentinel |
| AC-6 baseline tests | `node --test tests/*.test.mjs` same pass count + new gate tests |
| AC-7 next-ship sentinel | Tier-b ship card from next merge shows non-`n/a-not-installed` `privacyDenylistGate` value |

## Pickup pointer if interrupted

- Discovery mail (archived): `mailbox/archive/2026-05-07T1520-wise-grace-to-macbook-session-handoff-stage-5-6-privacy-gate-adoption.md`
- ai-brain reference implementation: `~/coding_projects/ai-brain/lib/privacy-denylist-gate.mjs` (485 LoC), `lib/privacy-denylist.mjs` (vendored from agent-working-memory@88b71434), `lib/privacy-denylist.provenance.json`
- ai-brain Stage 5.6 spec: `~/.claude/skills/ship/SKILL.md` lines 261-367
- ai-brain plan: `ai-brain/.ai-workspace/plans/2026-05-06-ship-adopts-privacy-denylist.final.md`
- Source module: `agent-working-memory/scripts/lib/privacy-denylist.mjs` (125 LoC, exports `DENYLIST_PATTERNS`, `findFirstMatch`, `findAllMatches`, `RULE_SPEC_ALLOWLIST`)
- Today's evidence: PR #28 ship card recorded `privacyDenylistGate: n/a-not-installed`; 3 plan-file leaks caught by manual cold-eyes review during ship
- agent-working-memory current state: v0.4.0, master at HEAD, no `lib/` directory yet

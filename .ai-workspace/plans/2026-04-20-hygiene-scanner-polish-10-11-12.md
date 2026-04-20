# hygiene scanner polish bundle (#10 + #11 + #12)

## ELI5

Yesterday I shipped the hygiene scanner upgrade to use `git ls-files` (v0.1.3, PR #9). The self-review filed 3 tiny "could be better" notes:

- **#10** — `git ls-files -z` without the `--recurse-submodules` flag silently skips submodule contents. The repo has no submodules today, but a future contributor adding one would create a blind spot. Fix: add a comment documenting the intentional scope limit so the next maintainer knows.
- **#11** — The `isAbsolute(rel) ? rel : join(root, rel)` line has a ternary branch that will never execute (git output is always relative). Add a comment saying "this guard is defensive, the other branch is unreachable today" so a future reader doesn't waste time wondering what repo state would trigger it.
- **#12** — If the `git ls-files` call fails (e.g., buffer overflow on huge repos, git not installed), the scanner silently falls back to walking the whole filesystem — which is the opposite of the fix we just shipped. Fix: when the failure is *unexpected* (not "not a git repo"), write a one-line warning to stderr so the maintainer sees the degradation.

All 3 fixes land in `src/hygiene.mjs` as small, bundled edits. No behavior change to the hot path.

## Context

This ships as the polish-of-polish follow-up to PR #9 (v0.1.3). The working tree is clean on `main` at v0.1.3. No other agent is working in this repo (agent-working-memory is a different working tree from ai-brain; clever-bob's lane is ai-brain).

### Shape of each edit

**#10 — submodule scope comment.** Add a comment block above the `execFileSync` call in `listTrackedFiles` explaining that `--recurse-submodules` is not used, the current repo has no submodules, and if one is introduced later the flag should be added. No code change.

**#11 — isAbsolute defensive comment.** Add a comment above the `.map` line noting `git ls-files` output is always repo-relative today; the `isAbsolute` guard is defensive against future git behavior changes. No code change.

**#12 — error-discriminating stderr log.** Change the bare `catch {` to `catch (err) {` and write a one-line warning to stderr when the error is NOT the expected "not a git repo" signal (`err.status === 128`) or missing-git-binary (`err.code === "ENOENT"`). Return `null` unchanged. The test at `tests/hygiene.test.mjs:26` calls `scanTree(tmp)` on a non-git tmpdir — that triggers `err.status === 128`, so no warning fires and the test stays silent.

### Why these specific choices

- **#10 doc-only, not `--recurse-submodules` flag change:** no submodule in the repo means no way to test the flag's effect. Doc-only is reversible, zero-risk, and flags the scope explicitly.
- **#11 keep the guard, add comment:** removing the guard is a code-change for a case that provably can't arise today. Keeping + documenting is lower-risk than deleting.
- **#12 log-only, not `spawnSync`-streaming or `maxBuffer`-bump:** the current 64 MiB buffer already covers ~500k paths; a streaming rewrite or buffer bump adds code surface for a hypothetical repo that doesn't exist yet. Log-only surfaces the degradation when it happens and defers the actual fix to "when it actually bites."

## Goal

1. `src/hygiene.mjs` gains three comment blocks / one small code change, all inside `listTrackedFiles`. No other function is touched.
2. Running the scanner against this repo's `main` HEAD remains clean (no new violations, no new exit-code changes).
3. All 3 existing tests in `tests/hygiene.test.mjs` still pass, including the non-git tmpdir test (no stderr noise from the fallback).
4. PR merges green and releases cleanly as v0.1.4 (patch bump, conventional `docs:` + `chore:` prefixes).

## Binary AC

All commands run from `agent-working-memory/` on the feature branch (pre-merge):

1. `grep -c 'submodule' src/hygiene.mjs` prints a number `>= 1` (the #10 comment landed).
2. `grep -c 'defensive' src/hygiene.mjs` prints a number `>= 1` (the #11 comment landed).
3. `grep -c 'fell back to walk' src/hygiene.mjs` prints `1` (the #12 stderr-log string is in place).
4. `grep -c 'err.status !== 128' src/hygiene.mjs` prints `1` (the discriminating check is in place).
5. `grep -c '^} catch {$' src/hygiene.mjs` prints `0` (the bare catch is gone — replaced with `catch (err)`).
6. `npm test 2>&1 | grep -cE '^# fail 0$'` prints `1` (zero-failures summary line present — the repo has 15 tests total across hygiene and resolveRoot suites; this AC asserts no regressions in any of them).
7. `npm test 2>&1 | grep -c 'fell back to walk'` prints `0` (no stderr noise during the non-git tmpdir test — the `err.status === 128` branch correctly suppresses it).
8. `node src/hygiene.mjs .` exits 0 (this repo's committed tree stays clean after the edit).
9. `git diff --name-only origin/main..HEAD | sort` prints exactly two lines, in alphabetical order: `.ai-workspace/plans/2026-04-20-hygiene-scanner-polish-10-11-12.md` and `src/hygiene.mjs`.

## Out of scope

- Actually enabling `--recurse-submodules` (would require a test-repo with a submodule to verify).
- Removing the `isAbsolute` guard (keeping it is the safer choice; the PR only documents).
- Switching `execFileSync` to `spawnSync` or bumping `maxBuffer` (premature for current repo sizes).
- Any change to `walk()`, `scanFile()`, `scanTree()`, `PATTERNS`, `ALLOWLIST`, or the CLI entry.
- Any new test.
- Touching any file outside `src/hygiene.mjs` and this plan file.

## Verification procedure

Reviewer runs, in order, from `agent-working-memory/` on the feature branch (pre-merge):

```bash
# AC-1..5 — comments + stderr-log code in place
grep -c 'submodule' src/hygiene.mjs                      # must print >= 1
grep -c 'defensive' src/hygiene.mjs                      # must print >= 1
grep -c 'fell back to walk' src/hygiene.mjs              # must print 1
grep -c 'err.status !== 128' src/hygiene.mjs             # must print 1
grep -c '^} catch {$' src/hygiene.mjs                    # must print 0

# AC-6..7 — tests still pass + no stderr noise from the non-git test
npm test 2>&1 | grep -cE '^# fail 0$'                    # must print 1
npm test 2>&1 | grep -c 'fell back to walk'              # must print 0

# AC-8 — scanner still clean on this repo
node src/hygiene.mjs .                                   # must exit 0

# AC-9 — diff scope
git diff --name-only origin/main..HEAD | sort
# must print, in alphabetical order:
#   .ai-workspace/plans/2026-04-20-hygiene-scanner-polish-10-11-12.md
#   src/hygiene.mjs
```

## Critical files

- `src/hygiene.mjs` — edit target. Three targeted edits, all inside `listTrackedFiles`. Do NOT touch any other function.
- `.ai-workspace/plans/2026-04-20-hygiene-scanner-polish-10-11-12.md` — this file. Commits alongside `src/hygiene.mjs`.

## Checkpoint

- [x] Plan written
- [ ] /coherent-plan pass clean
- [ ] Branch created off main
- [ ] `src/hygiene.mjs` edited (3 targeted comments/change)
- [ ] `npm test` green locally
- [ ] /ship invoked, PR opened, CI green, stateless review PASS, merge + release v0.1.4

Last updated: 2026-04-20T12:30:00Z (initial draft)

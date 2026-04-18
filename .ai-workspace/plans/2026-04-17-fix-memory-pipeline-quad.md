# Fix four bugs in the cairn + /ship memory pipeline

> **⚠️ SUPERSEDED 2026-04-17.** This plan is now a subset of the master plan at `.ai-workspace/plans/2026-04-17-cairn-memory-pipeline-overhaul.md` — its three ACs are inlined there as Phase 0. Do NOT execute from this file; read the master instead. Kept for decision-log traceability only.

## ELI5

Our "remember what shipped" pipeline has four leaks, all in the same plumbing. Think of it like a mail-sorting conveyor:

1. **The label printer (Stage 10) skips envelopes.** `/ship` is supposed to drop a note into the working-memory mailbox after every merge, but it's lying and saying "mailbox not found" when the mailbox is sitting right there.
2. **The drift alarm can't dial 911.** Every Monday a weekly audit finds sketchy stones and tries to open a GitHub issue to warn you — but the phone number (the `cairn-drift` label) doesn't exist, so the call fails every time.
3. **The "maybe" bin has no trash-out day.** Session notes that never got reinforced pile up at `confidence: 1` forever. 281 of them today. Nobody takes them out.
4. **The status light lies.** When you check "is the graduation runner working?", the lamp says "skipped" because it's wired to the wrong step. The real work logs are in another file that the status reader doesn't look at.

The four issues are independent of each other and can ship in any order. (Within issue #326 there IS a tiny ordering rule — create the label first, then harden the code — but that's intra-issue.) #1 and #2 are the user-visible ones.

## Context

Audit of the cairn + /ship memory pipeline on 2026-04-17 (hard-rule-9 measurement, not inference) surfaced four concrete bugs. Each is filed as a GitHub issue:

- **#325** — `/ship` Stage 10 records `cardEmission: "skipped:no-root"` on success runs even when gates pass. 4 of last 5 ship runs affected.
- **#326** — H6 weekly drift audit: every `gh issue create --label cairn-drift` fails because the label doesn't exist in `ziyilam3999/ai-brain`. Different root cause from closed #291 (PM2 env).
- **#327** — T2 session notes pile up indefinitely. 281 of 318 notes stuck at `confidence: 1` with no retention mechanism. Charter specifies T3 staleness at 90 days but says nothing about T2.
- **#328** — H5's heartbeat line records `[h5-step6-noop]` (the Gap 4 stub step) but NOT the graduation summary. `/cairn status` reads the wrong tier.

The four share a theme: **the memory pipeline records outcomes in the wrong place, or to the wrong signal, or not at all.** Each bug has a clear fix — none is architecturally deep.

Evidence for each finding is inline in the linked GitHub issues. Key files touched:
- `skills/ship/SKILL.md` — Stage 10 gate checks
- `cairn/bin/h6-audit.mjs` — gh issue creation
- `cairn/bin/h5-graduate.mjs` — heartbeat write after summary
- `claude-global-settings.json` OR `shared-hooks.json` — env var propagation
- `ziyilam3999/ai-brain` repo GitHub labels

## Goal

1. `/ship` success runs emit a working-memory card (or a *correct* skip reason) — no more false `skipped:no-root`.
2. H6 weekly drift audits that find problems create a real GitHub issue — no more silent `[gh-api-fail]` on every run.
3. T2 session notes have a bounded lifecycle — conf=1 singletons don't pile up unboundedly.
4. `/cairn status` shows what h5 actually did on its last run — no more "the light says noop so it must be broken."

## Binary AC

### AC-1 (issue #325) — Stage 10 gate checks are concrete

- **AC-1a**: The `## Stage 10` section in `ai-brain/skills/ship/SKILL.md` contains at least one fenced code block with executable gate-check commands. Verify: `sed -n '/^## Stage 10/,/^## /p' ai-brain/skills/ship/SKILL.md | grep -c '```'` returns ≥ 2.
- **AC-1b**: `WORKING_MEMORY_ROOT` is declared in either `ai-brain/claude-global-settings.json` or `ai-brain/shared-hooks.json`. Verify: `grep -c 'WORKING_MEMORY_ROOT' ai-brain/claude-global-settings.json ai-brain/shared-hooks.json` returns ≥ 1.
- **AC-1c**: The path resolved from `$WORKING_MEMORY_ROOT` (or default `$HOME/.claude/agent-working-memory/`) contains `tier-b/`. Verify: `test -d "${WORKING_MEMORY_ROOT:-$HOME/.claude/agent-working-memory}/tier-b" && echo pass` prints `pass`.

### AC-2 (issue #326) — H6 can create drift issues

- **AC-2a**: The `cairn-drift` label exists in `ziyilam3999/ai-brain`. Verify: `gh label list -R ziyilam3999/ai-brain --search cairn-drift` returns at least one row.
- **AC-2b**: After a forced h6 run where the gh call is known to fail (simulate by temporarily setting `GH_TOKEN=invalid`), the latest line in `$HOME/.claude/cairn/heartbeats.log` matching `h6 \[gh-api-fail` contains a colon-delimited reason suffix (e.g. `[gh-api-fail:label-missing]`, `[gh-api-fail:auth]`, `[gh-api-fail:rate-limit]`). Verify: `grep 'h6 \[gh-api-fail:' $HOME/.claude/cairn/heartbeats.log | wc -l` returns ≥ 1. A bare `[gh-api-fail]` (no colon, no reason) fails the AC.

### AC-3 (issue #327) — T2 retention policy exists

This AC has two forms depending on which retention option the user picks for #327. The executor MUST decide and record the choice (`retention-option: 1 | 2 | 3`) in the PR description before starting AC-3b work, so the reviewer knows which form to verify.

- **AC-3a** (all options): A retention policy decision is recorded in `ai-brain/hive-mind-persist/proposals/cairn/*.md`. Verify: `grep -c 'T2.*retention\|conf.*1.*stale\|tentative.*stale\|T2.*unbounded' ai-brain/hive-mind-persist/proposals/cairn/*.md` returns ≥ 1.
- **AC-3b-active** (if Option 1 or 2 selected): A retention sweep runs in h5 or h6. Verify: after a forced h5 or h6 run, `$HOME/.claude/cairn/heartbeats.log` contains a line with `t2_stale_marked=N` or `t2_retention_removed=N` (N ≥ 0). `grep -c 't2_stale_marked\|t2_retention_removed' $HOME/.claude/cairn/heartbeats.log` returns ≥ 1.
- **AC-3b-wontfix** (if Option 3 selected): Issue #327 is closed with `wontfix` label and a comment citing the proposal doc from AC-3a. Verify: `gh issue view 327 --json state,labels -q '.state + " " + (.labels[].name)'` includes `CLOSED` and `wontfix`.

### AC-4 (issue #328) — H5 heartbeat shows graduation summary

- **AC-4a**: After h5's next run, `$HOME/.claude/cairn/heartbeats.log` contains an h5-tagged line with counts (scanned/graduated/etc.). Verify: `grep 'h5.*scanned=' $HOME/.claude/cairn/heartbeats.log` returns ≥ 1 line.
- **AC-4b**: `cairn/bin/h5-graduate.mjs` writes to `heartbeat()` immediately after the `gradLog("[summary]", ...)` call. Verify by reading lines ~296–310 of the file: a `heartbeat(...)` invocation passes the same `stats` object keys.

## Out of scope

- Redesigning the H4 merge logic (already covered by closed #290 follow-ups).
- Shipping Gap 4 project-index refresh — the `[h5-step6-noop]` stub stays, only its *heartbeat payload* changes in AC-4.
- Changing the cairn T3 90-day staleness policy for knowledge-base entries.
- Any ship pipeline change other than Stage 10 gate checks.
- H6's invariant checkers (C1 stability, C3 dating) — separate design discussion.
- Retroactively cleaning the 281 existing conf=1 notes (separate manual step, not part of the automated fix).
- Touching forge-harness, monday-bot, or any other project's plumbing.

## Ordering constraints

Only one: **AC-2a must land before or in the same PR as AC-2b.** If the h6 code is hardened to read `r.stderr` but the label still doesn't exist, every run will produce a more verbose failure message — useful for debugging but still failing. Creating the label is the actual fix; hardening the code is defense-in-depth.

All other ACs are independent and can ship in any order.

## Verification procedure

```bash
cd ~/coding_projects/ai-brain

# AC-1: Stage 10
sed -n '/^## Stage 10/,/^## /p' skills/ship/SKILL.md | grep -c '```'     # expect >= 2
grep -c 'WORKING_MEMORY_ROOT' claude-global-settings.json shared-hooks.json  # expect >= 1
test -d "${WORKING_MEMORY_ROOT:-$HOME/.claude/agent-working-memory}/tier-b" && echo pass

# AC-2: h6 drift
gh label list -R ziyilam3999/ai-brain --search cairn-drift | wc -l         # expect >= 1
# AC-2b: after forcing a known gh failure and re-running h6
grep 'h6 \[gh-api-fail:' $HOME/.claude/cairn/heartbeats.log | wc -l             # expect >= 1

# AC-3: T2 retention (always)
grep -c 'T2.*retention\|conf.*1.*stale\|tentative.*stale\|T2.*unbounded' hive-mind-persist/proposals/cairn/*.md  # expect >= 1
# AC-3b-active (if Option 1 or 2 chosen): after forced h5 or h6 run
grep -c 't2_stale_marked\|t2_retention_removed' $HOME/.claude/cairn/heartbeats.log  # expect >= 1
# AC-3b-wontfix (if Option 3 chosen)
gh issue view 327 --json state,labels -q '.state + " " + (.labels[].name)' | grep -E 'CLOSED.*wontfix'

# AC-4: h5 heartbeat
# After next h5 fire (or manual: HEARTBEAT_KIND=h5 node cairn/bin/heartbeat-dispatch.mjs)
grep 'h5.*scanned=' $HOME/.claude/cairn/heartbeats.log | wc -l                # expect >= 1
```

## Critical files

- `ai-brain/skills/ship/SKILL.md` — Stage 10 gate checks (lines 427–460). Rewrite prose gates to concrete bash commands.
- `ai-brain/claude-global-settings.json` OR `ai-brain/shared-hooks.json` — declare `WORKING_MEMORY_ROOT` env var.
- `ai-brain/cairn/bin/h6-audit.mjs` — lines 133–149, the `gh issue create` block. Capture stderr; tag the heartbeat with the failure reason.
- `ai-brain/cairn/bin/h5-graduate.mjs` — around line 296 (the `gradLog("[summary]", ...)` call). Add parallel `heartbeat(...)` call with same payload.
- `ziyilam3999/ai-brain` GitHub labels — create `cairn-drift` (and consider also creating it in any repo h6 might run against).
- `ai-brain/hive-mind-persist/proposals/cairn/2026-04-13-cairn-charter.md` — document the chosen T2 retention policy (if Option 1 or 2 is picked).

## Checkpoint

- [ ] AC-1a: Rewrite Stage 10 gate checks in SKILL.md with concrete bash commands
- [ ] AC-1b: Declare `WORKING_MEMORY_ROOT` in global settings or shared hooks
- [ ] AC-1c: Verify resolved root has `tier-b/` (already true on this machine; confirms no regression)
- [ ] AC-2a: Create `cairn-drift` label in `ziyilam3999/ai-brain`
- [ ] AC-2b: Harden h6-audit.mjs to capture stderr and include it in heartbeat payload
- [ ] AC-3a: Decide T2 retention policy (Option 1/2/3) and document the choice
- [ ] AC-3b: If Option 1/2: implement retention sweep in h5 or h6
- [ ] AC-4a: Add `heartbeat(...)` call after h5 `[summary]` gradLog
- [ ] AC-4b: Verify next h5 fire writes counts to heartbeats.log
- [ ] Run full verification procedure
- [ ] Ship via `/ship` (AC-1 fix) — will exercise Stage 10 end-to-end
- [ ] Close issues #325, #326, #327, #328

Last updated: 2026-04-17T00:25:00Z (post-coherent-plan pass 1)

# Fix /ship Stage 10 card emission false-skip

> **⚠️ SUPERSEDED 2026-04-17.** This plan is now a subset of the master plan at `.ai-workspace/plans/2026-04-17-cairn-memory-pipeline-overhaul.md` — its content is inlined as Phase 0 AC-Q3. Do NOT execute from this file; read the master instead. Kept for decision-log traceability only.

## ELI5

After `/ship` finishes merging a PR, it's supposed to write a little "we shipped this" note into your working-memory notebook (Stage 10). But it's been lying — it says "I can't find the notebook" (`skipped:no-root`) when the notebook is right there on disk. The one time it worked was the session that *wrote* the Stage 10 instructions, because that session was paying close attention. Every session after that just skipped the step without actually checking. Two fixes: (1) give Claude a concrete bash command to run instead of prose to interpret, and (2) set the environment variable so gate 1 is a trivial pass.

## Context

- `/ship` SKILL.md Stage 10 (lines 427–460 in `ai-brain/skills/ship/SKILL.md`) specifies three gating conditions for card emission after a successful merge.
- Gate 1 checks for `$WORKING_MEMORY_ROOT` or default path `~/.claude/agent-working-memory/` with `tier-b/` inside.
- Gate 2 checks for `write-card.mjs` at known paths.
- Gate 3 checks for `outcome === "success"`.
- **All three gates currently pass on this machine** — the paths exist, the tool exists, runs are successful.
- Yet 4 of the last 5 successful ship runs record `cardEmission: "skipped:no-root"` and omit the `"card"` stage key from `stages`.
- The one success (PR #324) was the session that authored Stage 10 itself.
- Root cause: Stage 10's gate checks are prose descriptions. Claude reads "check if X exists" and substitutes a guess instead of actually running `ls` or `test -d`. This is the exact failure mode described by Hard Rule 9 ("measure before describing").

## Goal

1. Ship runs that satisfy all three gates produce `cardEmission: "emitted:..."` and a `"card"` stage key — no more false `"skipped:no-root"`.
2. The fix does not break runs where the gates genuinely fail (no AWM installed, tool missing, failed outcome).
3. `$WORKING_MEMORY_ROOT` is set in the session environment so gate 1 is a trivial env-var check rather than a filesystem probe.

## Binary AC

1. **AC-1**: `grep -c '"cardEmission"' ai-brain/skills/ship/SKILL.md` returns a count ≥ 1, confirming Stage 10 still exists and wasn't accidentally deleted.
2. **AC-2**: The Stage 10 section in SKILL.md contains at least one fenced bash code block with a concrete gate-check command (e.g., `test -d` or `ls`). Verify: `sed -n '/^## Stage 10/,/^## /p' ai-brain/skills/ship/SKILL.md | grep -c '```'` returns ≥ 2 (opening + closing fence).
3. **AC-3**: `echo $WORKING_MEMORY_ROOT` in a fresh Claude Code session prints a non-empty path. Verify by checking the env var is set in either `claude-global-settings.json` or `shared-hooks.json` via: `grep -c 'WORKING_MEMORY_ROOT' ai-brain/claude-global-settings.json ai-brain/shared-hooks.json` returns ≥ 1.
4. **AC-4**: The path printed by `$WORKING_MEMORY_ROOT` (or default `~/.claude/agent-working-memory/`) contains `tier-b/`. Verify: `test -d "${WORKING_MEMORY_ROOT:-$HOME/.claude/agent-working-memory}/tier-b" && echo pass` prints `pass`.

## Out of scope

- Changing Stage 10's card body format or metadata schema.
- Adding new stages to /ship.
- Modifying `write-card.mjs` or `memory-cli.mjs`.
- Changing how the pocket card (`tier-a.md`) is refreshed.
- Fixing any other /ship stages.
- Touching forge-harness or any project-level settings.

## Verification procedure

```bash
# 1. SKILL.md has concrete gate-check commands
cd ~/coding_projects/ai-brain
sed -n '/^## Stage 10/,/^## /p' skills/ship/SKILL.md | grep -c '```'
# expect: >= 2

# 2. Env var is configured
grep -c 'WORKING_MEMORY_ROOT' claude-global-settings.json shared-hooks.json
# expect: >= 1

# 3. Default path resolves
test -d "${WORKING_MEMORY_ROOT:-$HOME/.claude/agent-working-memory}/tier-b" && echo pass
# expect: pass
```

## Critical files

- `ai-brain/skills/ship/SKILL.md` — Stage 10 section (lines 427–460). Rewrite gate checks from prose to concrete bash commands.
- `ai-brain/claude-global-settings.json` OR `ai-brain/shared-hooks.json` — add `WORKING_MEMORY_ROOT` env var pointing to `~/.claude/agent-working-memory`.

## Checkpoint

- [ ] Rewrite Stage 10 gate checks in SKILL.md to include concrete bash gate-check commands
- [ ] Set `WORKING_MEMORY_ROOT` env var in settings or hooks
- [ ] Run verification procedure
- [ ] Ship via `/ship`

Last updated: 2026-04-17T00:00:00Z

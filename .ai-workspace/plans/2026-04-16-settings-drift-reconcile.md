# Follow-up Plan — Reconcile ~/.claude/settings.json drift with ai-brain canonical
Date: 2026-04-16
Status: **EXECUTED (Option Y) — closed 2026-04-16**
Depends on: `.ai-workspace/plans/2026-04-16-awm-hook-injection-fix.md` (closed)
Ships as: [ai-brain PR #309](https://github.com/ziyilam3999/ai-brain/pull/309)
        `fix(setup): move cairn hook registrations into canonical settings`

## Post-execution revision note
This plan was drafted with a paranoid "~1382 bytes of unknown drift, any of
it could be hiding another silent bug" premise. Inspection falsified that
premise: **100% of the drift was the 5 cairn hook registrations that
`setup.sh`'s `install_cairn_hooks()` was merging into the live file at
install time, plus a trailing-newline difference.** No other deltas.

The plan was restructured mid-execution around the actual root cause:
`install_cairn_hooks()` used a Python `os.replace(tmp, path)` step to merge
the cairn entries, which atomically renames a temp file over the target —
and that rename silently destroys the HardLink/symlink that `create_link`
had just built in step 5. Every install: link born, link killed. The
resulting regular file then drifted freely from canonical on every
subsequent ai-brain edit, which is how the `VAR=val bash /abs/path`
working-memory hook bug was allowed to silently persist in the live file
while the canonical had the correct shape all along.

Option Y (the more architectural fix) was chosen over Option X (a 3-line
`os.replace` → in-place write tweak): move the 5 cairn registrations into
canonical itself and delete the merge block entirely. Side effect: cairn
hooks become unconditionally registered at install time regardless of
probe verdict, but the hook scripts themselves already degrade gracefully
when `~/.claude/cairn/` is missing, so the effective contract is unchanged.

## ELI5
Claude Code reads one settings file that lives in your home folder. There's
supposed to be only one copy — the real one lives in the `ai-brain` repo, and
the home-folder file is supposed to be a *shortcut* pointing at the real one,
so edits anywhere go to the same place. Right now it's not a shortcut, it's
a separate copy, and the two copies have drifted. The home copy is ~1400
bytes bigger than the repo copy and we don't yet know what's different.

The recent SessionStart-hook bug happened because one of those drifted lines
was the wrong command shape. The repo copy was fine; the home copy was
broken. We fixed the one line. We have NOT fixed the drift — the two files
still disagree in other places, and any one of those disagreements could be
hiding a similar silent bug.

This plan does two things. First, it diffs the two files and merges them
into one reconciled version in the repo. Then it replaces the home-folder
copy with an actual shortcut to the repo file, so from now on there is only
one real copy and drift can't happen again. If the shortcut step can't work
on this machine (Windows is picky about symlinks), the plan falls back to
committing the reconciled file and running a small sync script.

## Context
- Root cause of the SessionStart-hook bug (fix plan 2026-04-16): the live
  `~/.claude/settings.json` had a hook command in a `VAR=val bash /abs/path`
  shape that the Windows hook runner couldn't parse. The canonical
  `ai-brain/claude-global-settings.json` already had the correct
  `bash ~/.claude/hooks/…` shape. Only the live file was broken.
- `~/.claude/settings.json` is 7341 B. `ai-brain/claude-global-settings.json`
  is 5959 B. Delta ≈ 1382 B. Content of that delta has NOT been inspected
  — the earlier plan was scoped to the one hook line.
- `~/.claude/settings.json` is a regular file, NOT a symlink
  (`ls -la` earlier showed no `->` arrow; `readlink` would return empty).
- CLAUDE.md's "Git & Sync Rules / ai-brain Sync" section currently states:
  `ai-brain/claude-global-settings.json → ~/.claude/settings.json` ("global
  Claude Code settings, linked by `setup.sh`"). That contradicts observed
  reality. Either `setup.sh` never ran on this machine, or `setup.sh` copies
  instead of symlinking, or something later clobbered the symlink with a
  regular file (e.g., an editor with "follow symlinks → copy" semantics).
  Worth determining during execution so the fix-direction is right.
- Any future edit to the canonical file (merged via PR to ai-brain) does
  NOT propagate to the live file today. Conversely, any local tweak to the
  live file does not propagate to ai-brain. Bi-directional silent drift.

## Goal
- The live `~/.claude/settings.json` contains content byte-identical to
  `ai-brain/claude-global-settings.json`, OR is a filesystem link to it.
- All currently-working behavior (cairn hook, inject-session-id hook,
  working-memory hook, skill permissions, statusline, PreToolUse hooks,
  MCP servers) continues to work after reconciliation. No regressions.
- Any hook `command` string in the reconciled file starts with `bash ` (or
  another executable name like `gh`, `node`, `python3` — NOT a `VAR=val`
  prefix). The cmd.exe parsing landmine cannot recur for any hook.
- A future edit to `ai-brain/claude-global-settings.json` automatically
  reaches the live Claude Code settings with at most one manual step
  (ideally zero, if symlink works).

## Approach
Four steps. Each is independently verifiable and reversible.

1. **Snapshot** both files: copy `~/.claude/settings.json` to
   `/tmp/awm-settings-live.snapshot.json` and `ai-brain/claude-global-settings.json`
   to `/tmp/awm-settings-canonical.snapshot.json`. Record md5s of each.
2. **Produce a side-by-side reconciliation table.** Use `diff -u` and a
   structured JSON-key walk to classify every difference as:
   - **live-only** — exists in live, not in canonical. For each entry
     decide: (a) merge into canonical (preserve), (b) discard (was local
     noise / accidental), (c) move to a separate `~/.claude/settings.local.json`
     (Claude Code supports this per-project override for permissions
     experiments the user doesn't want in ai-brain).
   - **canonical-only** — exists in canonical, not in live. Decide: merge
     into the live reconciliation (preserve) or surface as a regression
     the executor introduces to align live with canonical.
   - **agree** — both sides match, no action.
3. **Apply merge to canonical.** Edit `ai-brain/claude-global-settings.json`
   to contain the merged superset (everything preserved from step 2).
   Validate JSON. No other changes.
4. **Unify the live file with the canonical.** Two tracks, pick whichever
   works on this Windows host:
   - **Track A (symlink, preferred).** Delete `~/.claude/settings.json`,
     `ln -s` (with `MSYS=winsymlinks:nativestrict`) to
     `~/coding_projects/ai-brain/claude-global-settings.json`. Requires
     Windows Developer Mode enabled, OR the shell running with elevated
     privileges. `readlink ~/.claude/settings.json` must resolve to the
     canonical path.
   - **Track B (sync script + tracked copy, fallback).** If symlink
     creation fails (no dev mode, no admin, MSYS falls back to copy),
     instead: copy canonical → live, then add a one-liner to
     `ai-brain/scripts/setup.sh` that copies canonical over live whenever
     run. Also document in CLAUDE.md that the sync is copy-based on this
     host.

### Explicit decision gates (must be resolved BEFORE step 3)
- **DG-1** — Does `~/coding_projects/ai-brain/scripts/setup.sh` currently
  `ln -s` or `cp` settings.json? Grep it. If `cp`, the live-vs-canonical
  mismatch is expected every time setup runs and the fix is to change
  setup.sh to `ln -s` (Track A). If `ln -s`, something clobbered the
  symlink post-setup; investigate what (VS Code? a manual edit with a
  non-symlink-aware editor?).
- **DG-2** — Is Windows Developer Mode enabled? Check via
  `reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense`.
  Value `0x1` = enabled, `0x0` = disabled, key missing = disabled. If
  disabled, Track A is out and we go to Track B.

## Out of scope
- Drift in `hive-mind-settings.json`, `shared-hooks.json`, or any other
  dotfile — this plan only touches `settings.json`.
- Permissions list cleanup / audit (there's a lot of `Bash(…)` entries
  that could be consolidated; not this plan's job).
- MCP server config cleanup.
- Rewriting CLAUDE.md's sync-rules section beyond a one-line correction
  if Track B is chosen (to reflect "copy-based on Windows hosts without
  Dev Mode").
- Any change to `ai-brain/hooks/*.sh` or `~/.claude/hooks/*.sh`.
- Addressing the wrapper script `working-memory-session-start.sh` being
  a regular copy in `~/.claude/hooks/` rather than a symlink — same class
  of problem, but scoped separately for now.

## Critical files
- `~/.claude/settings.json` — live, 7341 B, host file, not in any repo.
  This plan either overwrites it with reconciled content OR deletes it
  and replaces with a symlink.
- `~/coding_projects/ai-brain/claude-global-settings.json` — canonical,
  5959 B, in ai-brain repo. This plan edits it with the merged superset
  and commits the edit as an ai-brain PR.
- `~/coding_projects/ai-brain/scripts/setup.sh` — inspected for DG-1;
  may be edited in Track B to include the sync copy.
- `~/coding_projects/ai-brain/parent-claude.md` — may get a one-line
  correction in Track B explaining that on Windows non-Dev-Mode hosts
  the sync is copy-based, not symlink-based.

## Binary AC
- **AC-D1**: After step 1, both snapshot files exist and their md5s are
  recorded in the checkpoint.
- **AC-D2**: After step 3, `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" ~/coding_projects/ai-brain/claude-global-settings.json`
  exits `0`. (Canonical still valid JSON after merge.)
- **AC-D3**: After step 3, every hook `command` string in the merged
  canonical file starts with a bare program token (not `VAR=val`). Check:
  `node -e "const j=require('/c/Users/ziyil/coding_projects/ai-brain/claude-global-settings.json'); const bad=[]; for (const ev of Object.values(j.hooks||{})) for (const b of ev) for (const h of (b.hooks||[])) if (h.type==='command' && /^[A-Z_][A-Z0-9_]*=/.test(h.command)) bad.push(h.command); console.log(JSON.stringify(bad)); process.exit(bad.length?1:0)"`
  exits `0` and prints `[]`.
- **AC-D4**: After step 4 (Track A), `readlink ~/.claude/settings.json`
  prints `/c/Users/ziyil/coding_projects/ai-brain/claude-global-settings.json`
  (or equivalent). OR (Track B), `diff -q ~/.claude/settings.json ~/coding_projects/ai-brain/claude-global-settings.json`
  exits `0` AND `grep -c 'claude-global-settings.json' ~/coding_projects/ai-brain/scripts/setup.sh`
  is at least `1`.
- **AC-D5**: In a fresh Claude Code session opened after step 4, the
  initial context contains both: (a) the `SessionStart:startup hook success:
  # Project Knowledge Index` reminder (cairn), and (b) the pocket-card
  reminder (`# Tier A — Pocket Card`). Ground truth that no hook broke.
- **AC-D6**: After AC-D5 passes, permissions still work: the fresh session
  can run `Bash(ls)` without a permission prompt (sanity-checks the
  `permissions.allow` list survived the merge).
- **AC-D7**: `git -C ~/coding_projects/ai-brain status` shows exactly
  one modified file (`claude-global-settings.json`) plus possibly
  `scripts/setup.sh` and `parent-claude.md` if Track B was taken — no
  accidental drive-by edits to unrelated ai-brain files.

## Rollback
- Step 1 snapshots are the rollback. Restore via
  `cp /tmp/awm-settings-live.snapshot.json ~/.claude/settings.json` and
  `cp /tmp/awm-settings-canonical.snapshot.json ~/coding_projects/ai-brain/claude-global-settings.json`.
- Track A symlink can be reverted to a copy with `rm ~/.claude/settings.json && cp /tmp/awm-settings-live.snapshot.json ~/.claude/settings.json`.
- Any ai-brain commit is a normal git revert.

## Verification procedure (for the reviewer)
1. Confirm md5 of `/tmp/awm-settings-live.snapshot.json` matches the
   pre-plan live file md5 `79c88b2a195262f84b93a6dc8b13bffe` (from the
   prior fix plan), plus whatever minor edits accumulated between then
   and this plan's start. Record the new md5.
2. Run AC-D1..D3 in place. All must pass before step 4.
3. Execute step 4 via the chosen track.
4. Run AC-D4.
5. Ask the user to open a fresh Claude Code session. Run AC-D5, AC-D6.
6. Run AC-D7 in ai-brain.

## Risks / unknowns
- **Windows symlinks without Dev Mode silently become copies.** MSYS2's
  default `ln -s` copies the file on Windows if `winsymlinks:nativestrict`
  is not set OR if the user lacks privilege. Decision gate DG-2 forces
  this to be explicit up-front instead of discovered mid-execution.
- **Claude Code may replace a symlinked settings.json with a regular
  file during upgrades.** Unknown whether the CC installer has this
  behavior. If Track A succeeds but the symlink vanishes after a CC
  upgrade, drift will silently recur. Mitigation: add a post-setup check
  to `setup.sh` that re-establishes the symlink if missing.
- **`settings.local.json` split complicates auditing.** If we move some
  live-only entries to a per-host local override file, the "one source
  of truth" promise weakens. Prefer merging everything into canonical
  unless a specific entry is clearly host-private (e.g., API keys —
  none currently observed, but worth re-checking).
- **The merge might expose surprises.** Live-only entries might be a
  forgotten experiment, an intentional override, or something like an
  in-progress skill permission. Human review required at step 2; not a
  mechanical merge.

## Checkpoint (post-execution)
- [x] DG-1 resolved: `setup.sh` intends symlink (create_link uses `ln -s` on POSIX, `New-Item -ItemType HardLink` on Windows). BUT `install_cairn_hooks` then used `os.replace(tmp, path)` which silently destroyed the link every install. Root cause identified.
- [x] DG-2 resolved: Windows Developer Mode **enabled** (`AllowDevelopmentWithoutDevLicense = 0x1`); `MSYS=winsymlinks:nativestrict ln -s` creates real symlinks on this host.
- [x] Snapshot both files; md5 of pre-swap live = `d91678f4e1cfb6f7dd82012187a7bf24` (saved to `/tmp/awm-settings.pre-hardlink.json`).
- [x] Reconciliation table produced via `diff -u`. Result: only diff is 5 cairn hook registrations + trailing newline. No surprise content.
- [x] Option Y chosen: move cairn registrations into canonical, delete `os.replace` merge block.
- [x] Edited `ai-brain/claude-global-settings.json` to add 5 cairn entries (SessionStart `cairn-session-start`, PreToolUse `cairn-tool-use`, PostToolUse `cairn-tool-use`, Stop `cairn-stop`, SessionEnd `cairn-session-end`). JSON validates.
- [x] Edited `ai-brain/scripts/setup.sh` to delete the `python3 ... os.replace` block from `install_cairn_hooks()`. Kept mkdir + probe + function-header comment (updated to document the old bug as historical context). Bash syntax clean.
- [x] Diff between edited canonical and then-current live file: only the trailing newline differs. Semantic no-op to swap.
- [x] Deleted live regular file; created Windows HardLink via `powershell New-Item -ItemType HardLink`. Verified: both paths land on inode `16607023627658206` with link count 2.
- [x] Wrapper hook still emits pocket card post-swap; JSON parses.
- [x] Committed ai-brain changes on branch `fix/cairn-hooks-in-canonical`, pushed, opened [ai-brain PR #309](https://github.com/ziyilam3999/ai-brain/pull/309).
- [ ] Fresh Claude Code session: pocket card reminder + cairn project-index reminder both present at SessionStart. **(Still pending — user opens a fresh terminal.)**
- [ ] Merge ai-brain PR #309; re-run setup.sh on this host to confirm it no-ops on the already-correct HardLink (rather than clobbering it). **(Pending post-merge.)**

## AC outcome
- AC-D1 ✅ (snapshot md5 recorded)
- AC-D2 ✅ (canonical JSON valid post-merge)
- AC-D3 ✅ (no hook command starts with `VAR=val` prefix in canonical)
- AC-D4 ✅ (HardLink installed; `stat -c %i` matches on both paths)
- AC-D5 **pending** (requires fresh session)
- AC-D6 **pending** (requires fresh session)
- AC-D7 ✅ (ai-brain `git status` shows exactly 2 modified files: `claude-global-settings.json` + `scripts/setup.sh`; committed cleanly)

## Deferred to post-merge
- Re-run `bash ~/coding_projects/ai-brain/scripts/setup.sh` after PR #309 merges. Expected: step 5 reports `[ok] ~/.claude/settings.json -> <canonical>` (no re-link needed because the HardLink already matches); step 8 runs mkdir + probe, no merge, no clobber. This proves the new setup.sh is idempotent and the HardLink survives repeat runs.
- If at any point the HardLink is broken (by an editor that rewrites instead of in-place-edits settings.json, by a Claude Code upgrade that replaces it, etc.), just re-run setup.sh — step 5 will rebuild.

Last updated: 2026-04-16

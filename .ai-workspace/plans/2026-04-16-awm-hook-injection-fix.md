# Fix Plan — agent-working-memory SessionStart hook stdout not reaching session context
Date: 2026-04-16
Depends on: `.ai-workspace/plans/2026-04-16-awm-hook-injection-diagnosis.md`

## ELI5
The sticky-note script is fine. The wrapper that hands the script off is fine.
The problem is the one line in the settings file that tells Claude Code *how*
to call the wrapper. Somebody changed that line to the wrong shape — a shape
that only works inside bash, not inside the Windows cmd box Claude Code uses
to launch hooks on this computer. So Claude Code reads the line, tries to run
it, and the cmd box says "I don't know what that is" and gives up silently. No
log, no error, no sticky note.

The fix is small: restore the one-line command to the shape that already lives
in the canonical ai-brain file. The wrapper is already installed and works;
it just wasn't being invoked. After the fix, each new session starts by
running the wrapper, which runs the real hook, which prints the pocket card
into the session context.

## Context
- Test plan `2026-04-16-awm-hook-injection-diagnosis.md` ran to a definitive
  diagnosis. Root cause: the live `~/.claude/settings.json` contains a hook
  command of shape `WORKING_MEMORY_ROOT=/abs/path bash /abs/path/script.sh`.
  On Windows, `cmd.exe` cannot parse a leading `VAR=val` token as an env
  assignment — it treats the whole token as a program name and fails:
  `'WORKING_MEMORY_ROOT' is not recognized as an internal or external command`.
- The other two SessionStart hooks (`cairn-session-start.sh`,
  `inject-session-id.sh`) use `bash ~/.claude/hooks/foo.sh`, which cmd.exe
  passes through to `bash.exe` cleanly. Their stdout reaches each new session
  as a `system-reminder`. Ours does not.
- The canonical source (`ai-brain/claude-global-settings.json`) already has
  the correct shape: `"command": "bash ~/.claude/hooks/working-memory-session-start.sh"`.
  A matching wrapper script is already present at
  `~/.claude/hooks/working-memory-session-start.sh` (regular file, 1063 B,
  identical to `ai-brain/hooks/working-memory-session-start.sh`). The wrapper
  searches `$HOME/coding_projects/agent-working-memory/hooks/session-start.sh`
  and `exec bash`s it. No env var needed — the real hook defaults
  `WORKING_MEMORY_ROOT` to `$HOME/.claude/agent-working-memory`, which is the
  exact path the broken live config was passing.
- Drift topology: `~/.claude/settings.json` (7341 B) is NOT a symlink to
  `ai-brain/claude-global-settings.json` (5959 B). The files have additional
  drift beyond this one hook. Out-of-scope for this fix: reconciling the
  remaining drift. In scope: making the working-memory hook block match
  canonical.

## Goal
- New Claude Code sessions inject the pocket card from
  `$HOME/.claude/agent-working-memory/tier-a.md` as a SessionStart
  `system-reminder`, alongside the Cairn project-index reminder and the
  mailbox-session-id additional-context reminder.
- The fix survives re-running `ai-brain/scripts/setup.sh` (i.e. the canonical
  file stays canonical, and any future sync from ai-brain → `~/.claude/` lands
  the correct shape).
- No other hook, setting, or environment variable is touched.

## Approach
Two-step, surgical:

1. **Edit the live `~/.claude/settings.json`** to replace the working-memory
   hook command with the canonical form:
   ```
   "command": "bash ~/.claude/hooks/working-memory-session-start.sh"
   ```
   (Drop the env-prefix; drop the absolute path; keep `timeout: 10` and the
   `startup|resume|clear|compact` matcher.)

2. **Verify drift does not re-introduce the bug.** Confirm the canonical
   source at `ai-brain/claude-global-settings.json` already has the same
   shape (it does, checked during the test plan). If so, no ai-brain edit
   needed — the drift only runs one direction (live has an extra broken
   line; canonical is correct).

3. **Revert the diagnostic instrumentation** in `hooks/session-start.sh`
   (the `/tmp/awm-hook.log` block). Keep it only if the user wants it as a
   permanent tracer; default is to remove it once the fix is verified.

## Out of scope
- `src/**` in `agent-working-memory` (refresh pipeline is fine).
- `$HOME/.claude/agent-working-memory/` store contents.
- Any other hook block in `~/.claude/settings.json`.
- The drift between `~/.claude/settings.json` and
  `ai-brain/claude-global-settings.json` outside of this one hook command.
- The wrapper script `~/.claude/hooks/working-memory-session-start.sh`
  itself (already correct).
- Any commits, branches, or PRs touching `~/.claude/settings.json` — that
  file is not in any repo. Host edit only.

## Critical files
- `~/.claude/settings.json` — **host file, not in repo.** One-line edit to
  the working-memory SessionStart hook command. Pre-edit snapshot required
  at `/tmp/awm-settings.pre-fix.json`. Replace the string
  `WORKING_MEMORY_ROOT=/c/Users/ziyil/.claude/agent-working-memory bash /c/Users/ziyil/coding_projects/agent-working-memory/hooks/session-start.sh`
  with `bash ~/.claude/hooks/working-memory-session-start.sh`. Keep JSON
  structure, `timeout: 10`, and the matcher intact.
- `hooks/session-start.sh` — in-repo. Remove the `--- diagnostic logging
  (2026-04-16, remove after fix verified) ---` block added by the test plan.
  On a fresh worktree off master this block is absent (the instrumentation
  was never committed), so `/delegate` pre-flight of AC-F6 will trivially
  pass against master. The working-tree copy in the planner's session still
  has it; reverting is a planner-local cleanup, not a PR-able change.
- `~/.claude/hooks/working-memory-session-start.sh` — read-only for this
  plan. Already correct; referenced by the new settings.json command.

### Executor scope note
This plan is ~90% host-level host-file edits (outside any repo) plus an
uncommitted-edit cleanup. There is **no in-repo code change, no branch, no
commit, no PR** in the scope of this plan. The executor's entire job is:
(a) snapshot + edit `~/.claude/settings.json`, (b) run AC-F1..F4 in-place,
(c) stop and report. AC-F5 is the user's ground-truth test in a fresh
terminal. The planner handles the working-tree instrumentation revert and
AC-F6 after AC-F5 passes (no executor role). `/delegate` pre-flight against
master in an isolated worktree is informational only for this plan — every
AC except F6 reads host state, not repo state.

## Binary AC
- **AC-F1**: After step 1, `grep -c 'WORKING_MEMORY_ROOT' ~/.claude/settings.json`
  reports `0`.
- **AC-F2**: After step 1,
  `grep -c 'bash ~/.claude/hooks/working-memory-session-start.sh' ~/.claude/settings.json`
  reports `1`.
- **AC-F3**: After step 1,
  `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" ~/.claude/settings.json`
  exits `0` (file still valid JSON).
- **AC-F4**: `bash ~/.claude/hooks/working-memory-session-start.sh` run
  standalone from Bash emits `# Tier A — Pocket Card` on stdout and exits `0`.
- **AC-F5** (post-fresh-session, requires user action): in a brand-new
  Claude Code session, the initial context contains a `system-reminder` block
  whose text starts with `# Tier A — Pocket Card`. This is the only AC that
  requires a new session to verify — all others are testable in-place.
- **AC-F6**: After step 3,
  `grep -c 'diagnostic logging' hooks/session-start.sh` reports `0` and
  `test -f /tmp/awm-hook.log` is still allowed (we don't delete the log,
  just stop appending to it).

## Rollback
- Step 1 is reversible: put the original command string back in
  `~/.claude/settings.json`.
- Step 3 is reversible: re-apply the instrumentation diff from the test
  plan.
- No git history on `~/.claude/settings.json` (it's not a repo), so keep a
  pre-edit copy at `/tmp/awm-settings.pre-fix.json` before editing.

## Verification procedure (for the reviewer)
1. `cp ~/.claude/settings.json /tmp/awm-settings.pre-fix.json` (snapshot).
2. Apply step 1 edit.
3. Run AC-F1..F4 in sequence. All must pass before proceeding.
4. Ask the user to open a new Claude Code session in another terminal and
   check the initial context for the `# Tier A — Pocket Card` reminder.
   (AC-F5.) If absent, revert via `cp /tmp/awm-settings.pre-fix.json
   ~/.claude/settings.json` and re-open the diagnosis plan — probably
   means the cmd.exe theory is wrong and we need to test H2 (node PATH at
   harness spawn) or H3 (harness-side stdout drop).
5. Apply step 3 (revert instrumentation). Run AC-F6.

## Risks / unknowns
- **cmd.exe theory is verified (high confidence) via `claude -p` side-effect
  probe.** After the test plan, a headless `claude -p "reply with the single
  word OK"` invocation spawned a fresh Claude Code session at local time
  ~02:03. Cairn's SessionStart hook left side-effects for that spawn
  (`~/.claude/cairn/sessions/2df7965e-edf0-4a00-91d1-8a7989691b8b.start`
  mtime 02:03; same session id appears in today's `t1-run-scratch/`). The
  working-memory hook's diagnostic log (`/tmp/awm-hook.log`) recorded
  **zero** new lines — not a partial entry, not a stderr redirect, zero
  bytes. The first statement in our instrumented hook is an unconditional
  `echo "---" >> /tmp/awm-hook.log` *before* `set -euo pipefail`, so any
  successful bash invocation would have left at least one line. Zero lines
  means bash never opened the script. Combined with the direct cmd.exe
  probe (`cmd //c "WORKING_MEMORY_ROOT=test bash -c '...'"` →
  `'WORKING_MEMORY_ROOT' is not recognized as an internal or external
  command`), the inescapable conclusion is that Claude Code's Windows hook
  runner passes the raw command string through a shell that rejects the
  leading env-prefix. Residual uncertainty is which shell specifically, not
  whether the parse failure is real. AC-F5 remains the canonical ground
  truth regardless.
- **Remaining drift in settings.json** may mask other silent failures in
  other hooks or permissions. Out of scope for this plan; flag for a
  follow-up "reconcile live settings with ai-brain canonical" pass.
- **The wrapper hard-codes `$HOME/coding_projects/agent-working-memory/…`**
  as the primary candidate path. Matches this machine. On a different
  machine with a different clone location, the wrapper would fall through
  to the next candidate or exit 0 silently. Non-issue for this user; worth
  a note for future multi-machine setup.

## Checkpoint
- [x] Snapshot `~/.claude/settings.json` to `/tmp/awm-settings.pre-fix.json` (md5 `79c88b2a…`)
- [x] Edit hook command in `~/.claude/settings.json` (step 1)
- [x] AC-F1..F4 pass (in-place: `grep WMR=0`, `grep wrapper=1`, JSON valid, wrapper emits pocket card + exit 0)
- [x] User opens a new Claude Code session and confirms AC-F5
      (fresh session's opening `SessionStart:resume hook success` reminder starts with `# Tier A — Pocket Card` and contains the `## Pinned` list. `/tmp/awm-hook.log` recorded a new `---` block at 2026-04-16T02:15:01+0800 with `WORKING_MEMORY_ROOT=unset` and `exit=0`, confirming the wrapper fired at real SessionStart and fell through to its built-in default path.)
- [x] Revert instrumentation in `hooks/session-start.sh` (step 3)
- [x] AC-F6 pass (`grep -c 'diagnostic logging' hooks/session-start.sh` = 0; `git diff hooks/session-start.sh` empty; `bash -n` clean)
- [x] No commit needed — the instrumentation was a working-tree-only edit, never committed. Working tree now matches master.

## Closure note (2026-04-16)
Fix verified end-to-end. Root cause confirmed: the live `~/.claude/settings.json`
hook command used a `WORKING_MEMORY_ROOT=<val> bash <abs-path>` shape that
Claude Code's Windows hook runner (cmd.exe-based per the probe) rejected as an
unknown program, so the hook never fired at real SessionStart. The canonical
`ai-brain/claude-global-settings.json` already had the correct
`bash ~/.claude/hooks/working-memory-session-start.sh` shape; the live file had
drifted. Live file now matches canonical for this hook block.

**Follow-up items (out of scope for this plan, flag for later):**
- `~/.claude/settings.json` (7341 B) still diverges from
  `ai-brain/claude-global-settings.json` (5959 B) outside this one hook block.
  Worth a reconcile pass to prevent future silent drift.
- `~/.claude/settings.json` is not version-controlled. Consider making it a
  symlink to the ai-brain canonical (the way CLAUDE.md describes it) so
  future edits in ai-brain propagate automatically and the reverse drift
  can't recur.

Last updated: 2026-04-16

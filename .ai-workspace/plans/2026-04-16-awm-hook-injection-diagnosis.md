# Test Plan — Diagnose agent-working-memory SessionStart hook injection failure
Date: 2026-04-16
Status: TEST (no fix applied yet)

## ELI5
There's a tiny script that should put a "memory sticky note" at the top of every
new chat. The sticky note isn't showing up. We don't know which step is broken:
the script might not be running at all, or it might be running and crashing, or
it might be running fine and the chat app is throwing the note away. We can't
tell just by looking — we need a receipt. So we tape a receipt printer onto the
script: every time it runs, it prints a line into a little log file. Then we
start a tiny throwaway chat and open the log. If the receipt is there with
"all good," the script ran and finished — which means the chat app ate the note.
If the receipt says "crashed" or isn't there at all, the problem is earlier.
Either way, the log tells us exactly where to go fix it.

## Context
- Symptom: in this very session, the two other `SessionStart` hooks' stdout
  surfaced as `system-reminder` blocks (the Cairn project-index dump and the
  `MAILBOX_SESSION_ID=…` additional-context line), but the working-memory
  hook's pocket-card output did NOT.
- Manual invocation of `hooks/session-start.sh` via the Bash tool is clean:
  exit 0, full pocket-card stdout, node resolves fine.
- Hook is registered in `$HOME/.claude/settings.json` inside the third
  `SessionStart` block, matcher `startup|resume|clear|compact`, command:
  `WORKING_MEMORY_ROOT=$HOME/.claude/agent-working-memory bash $HOME/coding_projects/agent-working-memory/hooks/session-start.sh`
  with `timeout: 10`.
- The other two hooks use simpler command strings (`bash $HOME/.claude/hooks/foo.sh`)
  with no `VAR=val` prefix and live under `$HOME/.claude/hooks/`.

## Hypotheses
- **H1** — Hook does not fire at harness-spawned SessionStart (e.g. the
  `VAR=val bash …` prefix is parsed as an unknown command, or Claude Code
  strips leading env assignments).
- **H2** — Hook fires but exits non-zero silently (e.g. the spawn environment
  has a different `PATH` and `node` is missing, so `node refresh.mjs` bails
  under `set -euo pipefail`).
- **H3** — Hook fires, exits 0, emits stdout, but the harness drops or merges
  its stdout (e.g. only the first matching block's stdout is forwarded, or a
  total-bytes cap is hit after the Cairn hook's ~5 KB project index).
- **H4** — Hook times out (`timeout: 10`; cold-start node on Windows is slow).
- **H5** — Output is surfaced but inside a reminder I didn't recognise —
  already ruled out: grepped all my initial system-reminder blocks for
  `Tier A`, zero hits.

## Instrumentation
Prepend a fire-receipt block to `hooks/session-start.sh` that runs BEFORE
`set -euo pipefail`, so even a later failure still leaves a receipt:

```bash
# --- diagnostic logging (2026-04-16, remove after fix verified) ---
{
  echo "---"
  echo "timestamp=$(date +%FT%T%z)"
  echo "pid=$$ ppid=$PPID"
  echo "WORKING_MEMORY_ROOT=${WORKING_MEMORY_ROOT:-unset}"
  echo "HOME=${HOME:-unset}"
  echo "PATH=$PATH"
  printf "node: "; command -v node || echo "NOT FOUND"
} >> /tmp/awm-hook.log 2>&1
exec 2>>/tmp/awm-hook.log
trap 'echo "exit=$? at $(date +%FT%T%z)" >> /tmp/awm-hook.log' EXIT
# --- end diagnostic logging ---
```

- `exec 2>>` redirects the rest of the script's stderr into the log, so any
  failure from `node refresh.mjs` or `cat` lands there verbatim.
- `trap … EXIT` records the final exit code even under `set -e` bail.
- `/tmp/awm-hook.log` is writable on Git Bash / MSYS2 (probed).

## Test procedure
1. Apply instrumentation to `hooks/session-start.sh`.
2. `rm -f /tmp/awm-hook.log /tmp/awm-hook.stdout`.
3. **Manual run** with the exact command string from `settings.json`:
   `WORKING_MEMORY_ROOT=$HOME/.claude/agent-working-memory bash $HOME/coding_projects/agent-working-memory/hooks/session-start.sh >/tmp/awm-hook.stdout; echo exit=$?`
4. Check AC-T1..T3 below.
5. Record pre-test marker: `date +%s > /tmp/awm-hook.pre`.
6. **Harness-spawn run** via headless Claude Code:
   `claude -p "reply with the single word OK" 2>&1 | tee /tmp/awm-hp-out.log | wc -c`
   A headless `claude -p` invocation spawns its own session; if the harness
   runs SessionStart hooks there, we'll see a new entry in the log.
7. Inspect `/tmp/awm-hook.log` and `/tmp/awm-hp-out.log`. Resolve AC-T4 and
   AC-T5.

## Binary AC
- **AC-T1**: `test -s /tmp/awm-hook.log` after step 3 (log non-empty).
- **AC-T2**: `head -1 /tmp/awm-hook.stdout` equals `# Tier A — Pocket Card`.
- **AC-T3**: Step 3 echoes `exit=0`.
- **AC-T4**: After step 6, at least one log entry in `/tmp/awm-hook.log` has a
  timestamp ≥ the epoch stored in `/tmp/awm-hook.pre`. Pass ⇒ hook fires under
  harness spawn. Fail ⇒ hook does NOT fire under harness spawn.
- **AC-T5**: After step 6, `grep -c 'Tier A' /tmp/awm-hp-out.log` ≥ 1. Pass ⇒
  harness forwards hook stdout into the spawned session. Fail ⇒ it does not
  (or headless `claude -p` suppresses hook stdout by design).

## Interpretation matrix
| T4 | T5 | Conclusion |
|----|----|------------|
| ✅ | ✅ | Chain works in fresh spawn; this interactive session missed it (stale settings cache, or hook hadn't been registered yet when SessionStart fired). Fix = restart settings load / verify edit time vs session start. |
| ✅ | ❌ | Hook fires, emits stdout, harness drops it. H3. Fix = change matcher/command shape to match the shape of the working hooks. |
| ❌ | —  | Hook does NOT fire under harness spawn. H1/H2/H4. Fix = remove `VAR=val` prefix, wrap in `$HOME/.claude/hooks/awm-session-start.sh`, or debug PATH/node. |
| —  | —  | (T4 fail auto-invalidates T5; check stderr tail in `/tmp/awm-hook.log`.) |

## Out of scope
- Any edit to `src/**` (refresh pipeline is not under test).
- Any edit to `$HOME/.claude/settings.json` during the test phase — settings
  changes are part of the fix plan, not this one.
- Deleting or re-seeding `$HOME/.claude/agent-working-memory/` — the store's
  contents are load-bearing user data.

## Checkpoint
- [ ] Instrumentation applied
- [ ] Manual run passes AC-T1..T3
- [ ] Harness-spawn run (`claude -p`) complete
- [ ] Interpretation matrix resolved (T4/T5 cell identified)
- [ ] Findings reported
- [ ] Fix plan written

Last updated: 2026-04-16

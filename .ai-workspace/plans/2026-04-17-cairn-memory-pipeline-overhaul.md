# Cairn + /ship memory pipeline overhaul (agent-centric)

## ELI5

My "learn from my own work" system is mostly recording the wrong stuff (every red-squiggle bash exit) and mostly ignoring the right stuff (the "aha, don't do X" insights I have mid-session). Same time, two unrelated mailboxes (cairn and working-memory) run in parallel without talking. The fix is not one big refactor — it's **five small phases**, each a few PRs, each shippable on its own:

1. **Phase 0 — Plug the three leaks already found.** Stage 10 false-skip (#325), h6 drift alarm (#326), and h5 status lamp = heartbeat payload (#328 — one bug, two framings). No design change. (3 PRs.)
2. **Phase 1 — Stop catching junk at the door.** The capture hook ignores known-benign `rm -f` / `git branch -d` style commands; the path-leak gate redacts paths from the whole note before rejecting. (2 PRs.)
3. **Phase 2 — Let real lessons graduate.** New `/cairn learn <text>` command writes agent-authored insights that skip the "two sessions must observe" gate. H4 merges by command family instead of exact-byte match so related tool failures stack. (3 PRs.)
4. **Phase 3 — Keep the pile usable.** Old low-signal notes move to an `archive/` folder the scanners skip. `/cairn find` ranks hand-authored insights above auto-captured anti-patterns. (2 PRs.)
5. **Phase 4 — Close the loop.** Reading a note reinforces it; working-memory cards emit a cairn-side entry too; a `status: wrong` reversal path exists; session-boundary hooks snapshot ephemeral state so /compact and /clear don't lose context silently. (4 PRs.)

**You do NOT have to commit to all five phases up front.** Each phase ships independently; after Phase 1 ships, we re-measure and decide whether Phase 2's clustering work is still worth the cost. This plan is the roadmap, not the contract.

## Context

Hard-rule-9 audit on 2026-04-17 surfaced the full picture:
- 483 of 497 T2 session notes are `kind: anti-pattern` bodies that are literally captured shell commands (e.g., `- tool-failure git branch -d X 2>&1`).
- Most are defensive idioms exiting non-zero by design (`rm -f` missing files, `git branch -d` on already-deleted branches).
- The graduation pipeline correctly refuses to promote these, but:
  - 298 of 320 in yesterday's 19:00Z scan were rejected as `low_conf` (conf < 3 because H4 body-hash clustering rarely merges across sessions).
  - 8 more rejected as `G3 generalizability` (inline absolute paths outside code fences slip past redaction).
- 4 entries DID graduate yesterday (P2, P3, F2, F3) — the pipeline end-to-end works; the feedstock is the problem.
- The explicit `#cairn-stone:` marker barely registers: 3 files mention the string, and they're multi-session anti-pattern merges, not dedicated stone entries.
- The cairn tier and the working-memory tier-b cards do not cross-reference each other, despite covering the same decisions.

User decision (2026-04-17): **accept unbounded T2 accumulation** (files are small, fast to read), BUT address three follow-up concerns (scan-cost at scale, find-result signal-to-noise, body-hash fragmentation) AND execute all A–H graduation improvements. This plan is the single roadmap.

Issue references: #325 (Stage 10), #326 (h6 label), #327 (T2 retention — to be closed wontfix with this plan linked), #328 (h5 heartbeat), umbrella issue TBD (A–H tracking).

This plan **supersedes** `2026-04-17-fix-memory-pipeline-quad.md` and `2026-04-17-fix-ship-stage10-card-emission.md`. Those are archived; their Phase 0 ACs are inlined here.

## Goal

1. Every shipped PR produces a persisted decision record that survives session compact (Phase 0, AC-Q3).
2. Every drift audit that finds real problems produces a real GitHub issue — not a silent log entry (Phase 0, AC-Q2).
3. `/cairn status` shows what the pipeline actually did, not a stub message (Phase 0, AC-Q1).
4. Capture signal-to-noise at T2 improves by ≥ 50% — measured as share of non-benign-idiom notes emitted per day (Phase 1).
5. Agent-authored insights reach T3 without requiring coincidental cross-session observation (Phase 2).
6. `/cairn find` result quality degrades gracefully as T2 grows — insights outrank anti-patterns (Phase 3).
7. The two memory tiers (cairn and working-memory) co-reinforce each other instead of running parallel (Phase 4).

## Out of scope

- Retroactively cleaning the 281 existing conf=1 notes (separate manual sweep; not automated).
- Redesigning the T3 schema (P/F/C/M/D series).
- Changing the T3 90-day staleness policy.
- Shipping Gap 4 project-index refresh — the `[h5-step6-noop]` stub stays.
- Any skill or stage outside ship/Stage 10 in Phase 0.
- Touching forge-harness, monday-bot, or any other project's plumbing.
- Introducing an LLM-based clusterer (Phase 2 C uses deterministic normalization, not embeddings).
- Migrating the raw `heartbeats.log` format (#286 already addressed).

## Phase 0 — Plug the quad leaks (unchanged from prior plan)

### AC-Q1 (issue #328) — H5 heartbeat payload

**AC-Q1.1**: After the next h5 run post-fix, `~/.claude/cairn/heartbeats.log` contains an h5-tagged line with counts (`scanned=`, `graduated=`, `dedup_skip=`, `low_conf=`, `gate_reject=`). Verify: `grep 'h5 .*scanned=' ~/.claude/cairn/heartbeats.log | wc -l` returns ≥ 1.

### AC-Q2 (issue #326) — H6 can create drift issues

**AC-Q2.1**: The `cairn-drift` label exists in `ziyilam3999/ai-brain`. Verify: `gh label list -R ziyilam3999/ai-brain --search cairn-drift | wc -l` ≥ 1.

**AC-Q2.2**: After a forced h6 run where the gh call fails (simulate by `GH_TOKEN=invalid`), the latest `h6 [gh-api-fail` line in `heartbeats.log` contains a colon-delimited reason suffix (e.g., `[gh-api-fail:label-missing]`). Verify: `grep 'h6 \[gh-api-fail:' ~/.claude/cairn/heartbeats.log | wc -l` ≥ 1. Bare `[gh-api-fail]` with no reason fails the AC.

### AC-Q3 (issue #325) — Stage 10 gate checks

**AC-Q3.1**: The `## Stage 10` section of `ai-brain/skills/ship/SKILL.md` contains at least one fenced code block with executable bash gate-check commands. Verify: `sed -n '/^## Stage 10/,/^## /p' skills/ship/SKILL.md | grep -c '```'` ≥ 2.

**AC-Q3.2**: `WORKING_MEMORY_ROOT` is declared in `ai-brain/claude-global-settings.json` or `ai-brain/shared-hooks.json`. Verify: `grep -c 'WORKING_MEMORY_ROOT' claude-global-settings.json shared-hooks.json` ≥ 1.

**AC-Q3.3**: The resolved root has `tier-b/`. Verify: `test -d "${WORKING_MEMORY_ROOT:-$HOME/.claude/agent-working-memory}/tier-b" && echo pass` prints `pass`.

**AC-Q3.4** (observable outcome): The next `/ship` success run records `cardEmission: "emitted:..."` and a `card: "pass"` stage key. Verify: `node -e "const d=JSON.parse(require('fs').readFileSync('skills/ship/runs/data.json','utf8')); const r=d.runs.at(-1); const ok=r.metrics.cardEmission.startsWith('emitted:') && r.stages.card==='pass'; console.log(ok?'pass':'fail', r.metrics.cardEmission, r.stages.card)"` prints a line starting with `pass`.

**Ordering within Phase 0**: AC-Q2.1 (label creation) must land before or with AC-Q2.2 (code change). All others independent.

## Phase 1 — Capture hygiene (reduce noise at source)

### AC-P1.1 (C.B) — Capture hook skip-list

**Intent**: The T1 capture hook should ignore commands matching known-benign patterns (exits non-zero by design, no information content). Candidate list: `rm -f`, `git branch -d`, `mkdir -p`, `touch`, any pipeline with `|| true` / `|| :` tail, any redirect-only sink (`>/dev/null 2>&1`).

**AC-P1.1a**: `hooks/cairn-stop.sh` (or the equivalent capture script) has a skip-list regex that rejects commands matching benign patterns BEFORE appending to `t1-run-scratch`. Verify: `grep -c 'skip\|benign\|ignore' hooks/cairn-*.sh` ≥ 1 (documenting intent).

**AC-P1.1b** (observable outcome): After 24 hours of normal use post-deploy, the rate of new T2 notes per day is ≥ 50% lower than the pre-fix baseline. Baseline measurement: `ls ~/coding_projects/ai-brain/hive-mind-persist/session-notes/2026-04-17-*.md | wc -l` on deploy day; compare to the same count 24h after deploy on day D+1 or later.

### AC-P1.2 (C.D) — G3 redaction over the whole body

**Intent**: The G3 "no absolute paths" gate currently redacts paths only inside fenced code blocks. Inline paths (most tool-failure bodies) slip through redaction but are caught by the check — which rejects lessons whose underlying content IS universal (just with paths embedded).

**AC-P1.2a**: `runGateCheck` in `cairn/bin/h5-graduate.mjs` redacts paths from the entire body copy before running the `G3` regex. Verify: graduate a synthetic T2 note whose body contains `cd /Users/foo && npm test`; it MUST pass G3 (provided it passes G1 and G2). Test command: `node -e "import('./cairn/bin/h5-graduate.mjs').then(m=>console.log(m.runGateCheck({text:'---\nsource-offsets:\n  - { session_id: a, line_offset: 1 }\n  - { session_id: b, line_offset: 2 }\ncreated: 2026-04-17\n---\ncd /Users/foo && npm test\n'})))"` prints `{ pass: true }`.

**AC-P1.2b** (observable outcome): In the week after deploy, G3 rejection count in `graduations.log` drops to < 5% of total scanned notes. Verify: `grep 'G3 generalizability' hive-mind-persist/cairn/graduations.log | wc -l` vs. sum of `scanned=N` from `[summary]` lines over the same window.

## Phase 2 — Structural (kind-aware gates + direct-write + semantic clustering)

### AC-P2.1 (C.F) — Kind-aware graduation gates

**Intent**: Hand-authored `kind: insight` and `kind: pattern` notes carry more signal per observation than auto-captured `kind: anti-pattern` tool-failure notes. The G1 stability requirement (≥2 sessions) that protects against accidentally graduating noise is overkill for deliberate authoring.

**AC-P2.1a**: `runGateCheck` applies a relaxed rule when `fm.kind` ∈ `{insight, pattern}` AND body has ≥ 40 chars of non-command-prefix content: G1 stability passes with 1 session. Verify: `node -e "import('./cairn/bin/h5-graduate.mjs').then(m=>console.log(m.runGateCheck({text:'---\nkind: insight\nsource-offsets:\n  - { session_id: a, line_offset: 1 }\ncreated: 2026-04-17\n---\nWhen the build fails with ETIMEDOUT on Windows, the fix is to kill node processes before retrying. This is a recurring issue that wastes ~5 minutes per occurrence.\n'})))"` prints `{ pass: true }`.

**AC-P2.1b**: The relaxed rule does NOT apply to `kind: anti-pattern` or `kind: summary`. Verify: the same synthetic test with `kind: anti-pattern` still returns `{ pass: false, reason: "G1 stability" }`.

### AC-P2.2 (C.A) — `/cairn learn <text>` direct-write

**Depends on**: AC-P2.1 landing first (kind: insight bypass must exist).

**Intent**: When an agent has a mid-session insight, a single command writes it directly into the T2 tier at `kind: insight` with `confidence: 1`, bypassing the tool-failure capture path. The next h5 fire can then graduate it to T3 via the Phase 2.1 relaxed rule.

**AC-P2.2a**: A `cairn learn <text>` subcommand exists in the dispatcher. Verify: `bash ~/.claude/skills/cairn/bin/cairn learn "When the Windows build fails with ETIMEDOUT, kill stale node processes before retrying; this recurs about once per week and wastes roughly five minutes each time"` exits 0 and prints a result line. (Test string is intentionally ≥ 40 chars to clear the Phase-2.1 kind-aware-gate length guard, matching the test input shape documented there.)

**AC-P2.2b**: After invocation, a T2 file exists with `kind: insight`, `confidence: 1`, and the supplied text in the body. Verify: `grep -l 'kind: insight' ~/coding_projects/ai-brain/hive-mind-persist/session-notes/*.md | wc -l` ≥ 1.

**AC-P2.2c**: After a forced h5 fire post-write, the insight either graduates to T3 or records a specific gate-reject reason in `graduations.log`. Verify: `grep 'insight\|kind=insight' ~/coding_projects/ai-brain/hive-mind-persist/cairn/graduations.log | wc -l` ≥ 1 AND the rejection reason (if any) is NOT "G1 stability" — acceptable outcomes are `[graduated]`, `G2 dating`, or `G3 generalizability`; any G1 rejection fails the AC.

### AC-P2.3 (C.C / B3) — H4 semantic clustering for tool failures

**Intent**: Today H4 clusters T2 entries by body hash — `tool-failure git branch -d A` and `tool-failure git branch -d B` land in separate files forever. Fragmentation prevents G1 stability from passing. Solution: for `kind: anti-pattern` entries, cluster by the first 3 tokens of the command (e.g., `tool-failure git branch` → one file, regardless of branch name), merging cross-session observations.

**AC-P2.3a**: `cairn/lib/cluster.mjs` (or equivalent) exposes a normalized-key function for tool-failure entries. Verify: `node -e "import('./cairn/lib/cluster.mjs').then(m=>console.log(m.normalizeToolFailureKey('tool-failure git branch -d feat-foo 2>&1')))"` prints a string identical to the one produced for `tool-failure git branch -d feat-bar 2>&1`.

**AC-P2.3b** (deterministic synthetic test, not wall-clock dependent): Seed H4 with 5 synthetic T1 entries of shape `tool-failure git branch -d <unique-name-N>` from 3 distinct synthetic session-ids (entries 1–2 from sid A, entry 3 from sid B, entries 4–5 from sid C). Force an h4 run. Verify: exactly ONE new T2 file is created (not 5), its frontmatter has `confidence: 3` (three distinct sessions merged), and its body contains all 5 branch-deletion lines. Command: invoke with `CAIRN_PERSIST_ROOT=/tmp/h4-test-$$ node cairn/bin/h4-compact.mjs` in a sandbox; assert with `ls /tmp/h4-test-$$/hive-mind-persist/session-notes/*.md | wc -l` = 1 AND `grep 'confidence: 3' /tmp/h4-test-$$/hive-mind-persist/session-notes/*.md | wc -l` = 1.

**AC-P2.3c**: Kind-specific keys are respected — `kind: insight` notes still cluster by their natural (title-based) key, not by command tokens. Verify: a synthetic insight with text "how to X" and another with text "how to Y" produce DIFFERENT keys.

## Phase 3 — Retention + discovery

### AC-P3.1 (B1) — Archive old low-conf T2 notes

**Intent**: Unbounded T2 growth is acceptable (user decision), but h5/h6 scanning every file every run is not. Move `confidence: 1`, `status: tentative` notes older than 30 days into `session-notes/archive/YYYY-MM/`; h5/h6 skip the archive; `/cairn find` searches the archive but ranks archived results last.

**AC-P3.1a**: After a forced h6 run post-deploy (with synthetic notes dated > 30 days ago), an `archive/YYYY-MM/` directory exists with ≥ 1 file. Verify: `ls hive-mind-persist/session-notes/archive/ 2>&1 | wc -l` ≥ 1.

**AC-P3.1b**: The archived files' frontmatter has `status: archived` and a `archived_at:` field. Verify: `head -10 hive-mind-persist/session-notes/archive/*/*.md | grep -c 'status: archived'` ≥ 1.

**AC-P3.1c**: h5 scan count drops by the number of archived files. Verify: compare `scanned=N` in `graduations.log` summaries before and after an archive sweep.

### AC-P3.2 (B2) — `/cairn find` ranks by kind

**Intent**: As T2 grows, raw lexical search returns mostly low-signal tool-failure bodies. Rank by kind so hand-authored insights surface first.

**AC-P3.2a**: `/cairn find` sort order is `kind:insight` > `kind:pattern` > `kind:anti-pattern` > `kind:summary`, then by recency. Verify: seed the store with 3 synthetic notes (one of each of the first three kinds) matching the same query term; run `cairn find <term>`; the insight appears before the pattern, which appears before the anti-pattern.

**AC-P3.2b**: Archived notes rank last regardless of kind. Verify: same test with one archived `kind: insight` — it appears after the non-archived anti-pattern.

## Phase 4 — Feedback loops + reversal

### AC-P4.1 (C.E) — Reading-as-reinforcement

**Intent**: When an agent runs `/cairn find X`, sees note N in results, and note N's text appears in the agent's next shipped PR body, confidence of N bumps by 1.

**AC-P4.1a**: `/cairn find` logs its top-N results (by ID) to `~/.claude/cairn/find-history.jsonl`. Verify: run `cairn find foo`; `tail -1 ~/.claude/cairn/find-history.jsonl | jq '.results | length'` ≥ 1.

**AC-P4.1b**: A new heartbeat runner (or a Stage in `/ship`) scans recently-merged PR bodies for substrings matching any ID in `find-history.jsonl` from the last 24h; on match, bumps the matched note's `confidence` by 1 and appends `reinforced-by-pr: <url>` to frontmatter. Verify: synthetic test — write an insight N, run find, create a PR with N's text in the body, merge; after the runner fires, `grep 'reinforced-by-pr' hive-mind-persist/session-notes/<N>.md | wc -l` ≥ 1.

### AC-P4.2 (C.G) — Working-memory ↔ cairn cross-pollination

**Intent**: Every tier-b card write also emits a cairn T1 entry with `signal: high`. Every cairn T3 graduation mirrors into a tier-b card under topic `cairn-kb`.

**AC-P4.2a**: `memory write` in `agent-working-memory/src/memory-cli.mjs` appends a T1 entry to `~/.claude/cairn/t1-run-scratch/<date>/<session>.jsonl` with `kind: insight, payload.signal: high`. Verify: run `memory write --topic x --id y --title "z"`; `grep 'signal.*high' ~/.claude/cairn/t1-run-scratch/$(date -u +%Y-%m-%d)/*.jsonl | wc -l` ≥ 1.

**AC-P4.2b**: When h5 graduates a T2 to T3, it also writes a tier-b card under `tier-b/topics/cairn-kb/`. Verify: force h5 with a synthetic high-signal insight; after graduation, `ls ~/.claude/agent-working-memory/tier-b/topics/cairn-kb/*.md | wc -l` ≥ 1.

### AC-P4.4 — Session-boundary state snapshot (new, from 2026-04-17 user input)

**Intent**: Manual card-writing before `/compact` relies on agent discipline, which fails. Research (claude-code-guide, 2026-04-17) confirms the honest product landscape:
- `PreCompact` hook EXISTS — can run a shell command, can BLOCK with exit 2, but CANNOT inject context or command the agent to write cards.
- `PreClear` hook does NOT exist — `/clear` triggers `SessionStart` only AFTER the clear, when context is already gone.
- `SessionEnd` fires AFTER session close; unreliable on abrupt termination.

Given hooks can't command the agent, full card-authorship automation is impossible at this layer. Best-achievable hybrid: (a) the hook snapshots shell-observable ephemeral state as a "session bookmark" on every destructive event AND on every Stop, so the most-recent bookmark is at most one turn stale; (b) `PreCompact` *optionally* blocks and warns the user if significant work happened with zero cards written, forcing a decision point; (c) `SessionStart` reads the most recent bookmark and primes the resumed agent.

**AC-P4.4a**: A `PreCompact` hook entry exists in `ai-brain/claude-global-settings.json` that invokes `hooks/session-bookmark.sh`. Verify: `grep -c 'PreCompact' ai-brain/claude-global-settings.json` ≥ 1 AND the referenced script exists and is executable.

**AC-P4.4b**: `SessionEnd` hook also invokes `session-bookmark.sh`. Verify: `grep -A 5 'SessionEnd' ai-brain/claude-global-settings.json | grep -c 'session-bookmark'` ≥ 1.

**AC-P4.4c**: `Stop` hook invokes an incremental bookmark (cheap, fast — updates the same bookmark file). Verify: `grep -c '"Stop"' ai-brain/claude-global-settings.json` ≥ 1 AND the hook runs in under 500ms on a cold cache. Test: `time bash hooks/session-bookmark.sh --incremental` completes in < 0.5s.

**AC-P4.4d**: After the hook fires, `~/.claude/session-bookmarks/<session-id>.md` exists and contains: the current task list (from `TaskList` or a cached copy), plans modified this session (file paths), files edited in the last 120 minutes (`find … -mmin -120`), and any cairn/working-memory cards written this session. Verify: force a Stop event; `ls ~/.claude/session-bookmarks/*.md | wc -l` ≥ 1 AND the most recent file contains at least two of those four sections.

**AC-P4.4e**: `SessionStart` (`startup|resume|clear|compact` matcher) reads the most recent bookmark and emits it as additional context via stdout (the hook output is injected into the next agent turn). Verify: after a simulated /compact, the next user-prompt context contains a `## Session bookmark` section (check via SessionStart:compact hook-output capture in `~/.claude/cairn/heartbeats/session-start-output.log` or equivalent, specified by the executor based on current infra).

**AC-P4.4f** (discipline gate, optional): `PreCompact` blocks with exit 2 if session-significance heuristics pass (≥ 20 tool calls AND ≥ 1 files edited) AND zero tier-b cards were written this session. Detection mechanism for "cards written this session": compare `tier-b/topics/**/*.md` file mtimes to the session start timestamp captured at SessionStart (write it to `~/.claude/session-bookmarks/<session-id>.start-ts`). Override: a file sentinel at `~/.claude/.compact-force` (the user creates it before re-running /compact, the hook deletes it on read). Verify: synthetic session with heavy tool use and zero cards; `/compact` exits non-zero; with sentinel present, `/compact` passes and sentinel is consumed.

**Ordering**: AC-P4.4 is independent of other Phase 4 ACs but conceptually precedes P4.1/P4.2 — a bookmark is the fallback for when reinforcement and cross-pollination haven't happened. Ship P4.4 early in Phase 4.

**Product gap note**: A future Claude Code improvement would be a `PreCompact` return shape that lets the hook request the agent to perform specific actions before compacting (not just block). Until then, card-writing remains a shared responsibility: agent discipline + shell-level snapshot safety net.

### AC-P4.3 (C.H) — `status: wrong` reversal

**Intent**: When an earlier insight turns out to be incorrect, mark it `status: wrong` + `corrected-by: <path>` instead of deleting. Graduation-time checks treat `status: wrong` as negative evidence; `/cairn find` surfaces them behind a flag.

**AC-P4.3a**: `classify.mjs` accepts `status: wrong` as a valid frontmatter value (not a quarantine-triggering EFRONTMATTER error). Verify: `node -e "import('./cairn/lib/classify.mjs').then(m=>{try{m.classify('---\nstatus: wrong\nkind: insight\n---\nbody');console.log('ok');}catch(e){console.log('err:'+e.code);}})"` prints `ok`.

**AC-P4.3b**: `runGateCheck` rejects `status: wrong` notes with reason `G4 reversed` (matching the existing G1/G2/G3 gate-name convention). Verify: synthetic test with `status: wrong` returns `{ pass: false, reason: "G4 reversed" }`.

**AC-P4.3c**: `/cairn find` hides `status: wrong` notes unless invoked with `--include-wrong` flag. Verify: seed a `status: wrong` note matching query `zzz`; `cairn find zzz` returns 0 results; `cairn find zzz --include-wrong` returns 1.

## Ordering constraints

1. **Phase 0 first**: Quad fixes are already-approved independent PRs. Ship before starting Phase 1. No inter-phase dependency from later phases back to Phase 0.
2. **AC-P2.2 depends on AC-P2.1**: `/cairn learn` relies on the kind-aware gate being live, otherwise learned insights will gate-reject on G1 stability.
3. **AC-P3.2 depends on AC-P2.2**: Ranking by kind is meaningful only after `kind: insight` notes exist in the store.
4. **AC-P4.1 depends on AC-P2.2**: Reading-as-reinforcement is tested against insights written via `/cairn learn`.
5. **AC-P4.2 depends on AC-P2.2**: Cross-pollination wants `kind: insight` as the T1 signal kind.
6. All other ACs are independent within their phase.
7. Phases 1, 3, 4 have no inter-phase dependency on Phase 2 strictly. But **we re-measure signal quality after each phase** and decide whether the next phase's cost is justified — Phase 1 may eliminate most of Phase 2's motivation.

## Verification procedure (per phase)

```bash
cd ~/coding_projects/ai-brain

# Phase 0
grep 'h5 .*scanned=' ~/.claude/cairn/heartbeats.log | wc -l                # Q1.1 >= 1
gh label list -R ziyilam3999/ai-brain --search cairn-drift | wc -l         # Q2.1 >= 1
grep 'h6 \[gh-api-fail:' ~/.claude/cairn/heartbeats.log | wc -l            # Q2.2 >= 1
sed -n '/^## Stage 10/,/^## /p' skills/ship/SKILL.md | grep -c '```'       # Q3.1 >= 2
grep -c 'WORKING_MEMORY_ROOT' claude-global-settings.json shared-hooks.json # Q3.2 >= 1
test -d "${WORKING_MEMORY_ROOT:-$HOME/.claude/agent-working-memory}/tier-b" && echo pass
node -e "const d=JSON.parse(require('fs').readFileSync('skills/ship/runs/data.json','utf8')); const r=d.runs.at(-1); console.log(r.metrics.cardEmission, r.stages.card)"

# Phase 1 (post-deploy, wait 24h)
grep -c 'skip\|benign\|ignore' hooks/cairn-*.sh                            # P1.1a >= 1
# P1.1b: compare `ls session-notes/<today>-*.md | wc -l` day-to-day — expect >= 50% drop
node -e "import('./cairn/bin/h5-graduate.mjs').then(m=>console.log(m.runGateCheck({text:'---\nsource-offsets:\n  - { session_id: a, line_offset: 1 }\n  - { session_id: b, line_offset: 2 }\ncreated: 2026-04-17\n---\ncd /Users/foo && npm test\n'})))"  # P1.2a -> { pass: true }

# Phase 2
node -e "import('./cairn/bin/h5-graduate.mjs').then(m=>console.log(m.runGateCheck({text:'---\nkind: insight\nsource-offsets:\n  - { session_id: a, line_offset: 1 }\ncreated: 2026-04-17\n---\nWhen the build fails with ETIMEDOUT on Windows, kill node processes before retrying. Recurring issue costing ~5 min each time.\n'})))"  # P2.1a -> { pass: true }
bash ~/.claude/skills/cairn/bin/cairn learn "test insight about foo"       # P2.2a exit 0
grep -l 'kind: insight' hive-mind-persist/session-notes/*.md | wc -l       # P2.2b >= 1
node -e "import('./cairn/lib/cluster.mjs').then(m=>console.log(m.normalizeToolFailureKey('tool-failure git branch -d feat-foo 2>&1')))"  # P2.3a deterministic key

# Phase 3
ls hive-mind-persist/session-notes/archive/ 2>&1 | wc -l                    # P3.1a >= 1
# P3.2: semi-manual synthetic test, documented in PR

# Phase 4
tail -1 ~/.claude/cairn/find-history.jsonl | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).results.length))"  # P4.1a >= 1
node -e "import('./cairn/lib/classify.mjs').then(m=>{try{m.classify('---\nstatus: wrong\nkind: insight\n---\nbody');console.log('ok');}catch(e){console.log('err:'+e.code);}})"  # P4.3a ok
```

## Critical files

### Phase 0
- `ai-brain/skills/ship/SKILL.md` — Stage 10 prose gates → concrete bash.
- `ai-brain/claude-global-settings.json` or `ai-brain/shared-hooks.json` — declare `WORKING_MEMORY_ROOT`.
- `ai-brain/cairn/bin/h5-graduate.mjs` — add `heartbeat(summary)` after the `gradLog("[summary]", …)` call (line ~296).
- `ai-brain/cairn/bin/h6-audit.mjs` — capture `r.stderr` in `[gh-api-fail:reason]` tagging (lines 133–149).
- GitHub labels: create `cairn-drift` in `ziyilam3999/ai-brain`.

### Phase 1
- `ai-brain/hooks/cairn-stop.sh` (or equivalent capture script) — skip-list regex.
- `ai-brain/cairn/bin/h5-graduate.mjs:95-117` — extend `redactCodeRegions` to redact whole-body before G3 check.

### Phase 2
- `ai-brain/cairn/bin/h5-graduate.mjs:119-128` — kind-aware gate branch.
- `ai-brain/skills/cairn/bin/cairn-learn.mjs` — new subcommand.
- `ai-brain/skills/cairn/bin/cairn` — dispatcher entry for `learn`.
- `ai-brain/cairn/lib/cluster.mjs` — normalized-key helper.
- `ai-brain/cairn/bin/h4-compact.mjs:170-270` — switch from body-hash basename to normalized-key basename.
- `ai-brain/cairn/lib/classify.mjs` — accept `kind: insight`.

### Phase 3
- `ai-brain/cairn/bin/h6-audit.mjs` (or a new `archive.mjs`) — age-out sweep.
- `ai-brain/skills/cairn/bin/cairn-find.mjs` — rank-by-kind.

### Phase 4
- `ai-brain/skills/cairn/bin/cairn-find.mjs` — log to `find-history.jsonl`.
- `ai-brain/cairn/bin/reinforce.mjs` — new runner or a post-merge hook.
- `agent-working-memory/src/memory-cli.mjs` — emit T1 entry on `memory write`.
- `ai-brain/cairn/lib/classify.mjs` — accept `status: wrong`.
- `ai-brain/skills/cairn/bin/cairn-find.mjs` — `--include-wrong` flag.
- `ai-brain/hooks/session-bookmark.sh` — new hook script for AC-P4.4.
- `ai-brain/claude-global-settings.json` — wire `PreCompact`, `Stop`, and `SessionEnd` entries to `session-bookmark.sh`; extend `SessionStart` to read the bookmark.

## Checkpoint

### Phase 0 — quad fixes (3 PRs) — ✅ COMPLETE 2026-04-17
- [x] AC-Q1 — h5 heartbeat payload (PR #336, v0.18.0)
- [x] AC-Q2.1 — create `cairn-drift` label (out-of-band via `gh label create`)
- [x] AC-Q2.2 — h6 stderr capture (PR #339, v0.18.1)
- [x] AC-Q3.1 — Stage 10 concrete gate checks in SKILL.md (PR #334, prior session)
- [x] AC-Q3.2 — `WORKING_MEMORY_ROOT` declared in settings/hooks (PR #334)
- [x] AC-Q3.3 — tier-b directory exists (verified)
- [x] AC-Q3.4 — `/ship` runs emit cards (proven by PR #336 + #339 emitting successfully)

### Phase 1 — capture hygiene (2 PRs)
- [ ] AC-P1.1 — capture-hook skip-list
- [ ] AC-P1.2 — G3 redaction over whole body
- [ ] Re-measure: daily T2 emission rate vs baseline; decide whether Phase 2 is still needed

### Phase 2 — structural (3 PRs)
- [ ] AC-P2.1 — kind-aware graduation gate
- [ ] AC-P2.2 — `/cairn learn` subcommand (depends on P2.1)
- [ ] AC-P2.3 — H4 semantic clustering

### Phase 3 — retention + discovery (2 PRs)
- [ ] AC-P3.1 — archive sweep
- [ ] AC-P3.2 — `/cairn find` rank by kind

### Phase 4 — feedback + reversal (4 PRs)
- [ ] AC-P4.1 — reading reinforcement
- [ ] AC-P4.2 — cairn ↔ working-memory cross-pollination
- [ ] AC-P4.3 — `status: wrong` reversal
- [ ] AC-P4.4 — session-boundary state snapshot (PreCompact + SessionEnd + Stop + SessionStart primer)

### Close-out
- [x] Close issues #325 (as fixed), #326 (auto via PR), #328 (auto via PR); #327 as wontfix + link to this plan.
- [x] File umbrella issue [#342](https://github.com/ziyilam3999/ai-brain/issues/342) "Cairn: agent-centric graduation improvements (A-H)" tracking Phases 1-4.
- [x] Archive prior plans `2026-04-17-fix-memory-pipeline-quad.md` and `2026-04-17-fix-ship-stage10-card-emission.md` (superseded banners added earlier session).

## Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-17 | Accept unbounded T2 accumulation (was #327 → wontfix) | Files are small; agent reads are fast; retention concerns are cheaper to solve via archive (P3.1) + ranking (P3.2) than via deletion. |
| 2026-04-17 | Supersede `fix-memory-pipeline-quad.md` into this plan | The quad was a subset; folding it in keeps one source of truth. |
| 2026-04-17 | 5-phase sequential rollout, not all-at-once | Phase 1 may eliminate most of Phase 2's motivation; measure before building. |
| 2026-04-17 | Deterministic clustering in P2.3, not embeddings | Matches cairn's existing "mechanical, same-button" charter principle. |
| 2026-04-17 | `/cairn learn` bypasses G1 but not G2/G3 | Explicit authoring is a signal; dating and path-leak checks remain universal. |
| 2026-04-17 | Add AC-P4.4 session-boundary snapshot to Phase 4 | Manual card-writing before /compact relies on discipline which fails. Research confirms hooks can't command the agent, but can snapshot shell-observable state and optionally block /compact. Hybrid: bookmark + optional discipline gate. |
| 2026-04-17 | PreClear hook gap accepted (no workaround) | Claude Code does not expose PreClear. Partial mitigation via Stop-hook incremental bookmarks (at most one turn stale). Clean solution requires Anthropic product change. |

Last updated: 2026-04-17T15:20:00Z (Phase 0 complete — all 4 quad ACs shipped; close-out done; umbrella #342 filed)

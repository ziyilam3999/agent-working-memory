# agent-working-memory

A two-tier decision memory mechanism for AI coding agents.

- **Tier A — Pocket Card**: a small (<5 KB) markdown digest injected into every session, holding pinned decisions and a recent-work summary.
- **Tier B — Decision Library**: an unbounded tree of decision cards on disk, one file per decision, grouped by topic.

This repository is the **public mechanism**: source code, hooks, tests, templates, installer, and docs. It contains **zero real user content**. Your actual decisions live in a separate private store on your machine (default: `$HOME/.claude/agent-working-memory/`).

## Install

Install from a git clone (v0.1.0 is not published to any package registry).

```bash
git clone https://github.com/<your-gh-login>/agent-working-memory.git
cd agent-working-memory
bash scripts/install.sh
```

The installer creates the default working-memory root at `$HOME/.claude/agent-working-memory/` with an empty `tier-b/topics/` tree and a seed `tier-a.md`. Set `WORKING_MEMORY_ROOT` before running the installer to override the path.

Node 18+ is required to run the CLI and tests.

## First card walkthrough

Write your first decision card:

```bash
node src/memory-cli.mjs write \
  --topic architecture \
  --id use-esm \
  --title "use ESM across the codebase"
```

Then rebuild the Tier A pocket card:

```bash
node src/memory-cli.mjs refresh
```

The refreshed pocket card is written to `$WORKING_MEMORY_ROOT/tier-a.md`. The SessionStart hook at `hooks/session-start.sh` does this automatically at the start of each Claude Code session.

To see what would be produced without writing to disk:

```bash
node src/memory-cli.mjs compact
```

## /ship integration (forward reference — P4)

Later phases will wire this mechanism into the `/ship` command so that every merged PR becomes a decision card automatically. See the parent plan's philosophy section for the full design. That wiring is NOT part of v0.1.0 — v0.1.0 is install-from-clone and manual card writes only.

## Comparison with cairn

Both `cairn` and `agent-working-memory` persist context across sessions, but they target different needs:

| aspect               | cairn                                 | agent-working-memory               |
|----------------------|---------------------------------------|------------------------------------|
| scope                | scratch / session / knowledge-base    | pinned decisions + recent summary  |
| lifecycle            | promotion pipeline (T1 to T3)         | deterministic compaction           |
| size                 | unbounded, tiered                     | Tier A is budget-capped (<5 KB)    |
| injection point      | specific prompt phases                | SessionStart hook                  |
| content classification | free-form notes                     | one-topic-per-card decisions       |

They are complementary. You can run both.

## philosophy

The design philosophy is: **file over memory** (everything is a plain markdown file on disk), **deterministic over clever** (v1 compaction is pinned + last-30d + topic counts, no LLM), and **mechanism separate from content** (this public repo holds no real user data — ever). See the parent plan in the ai-brain workspace for the full rationale.

## Development

Run the full test suite:

```bash
npm test
```

Run the hygiene scanner alone (useful for audits):

```bash
npm run hygiene
```

See `docs/` for architecture notes, hygiene policy, and integration reference.

## License

MIT. See `LICENSE`.

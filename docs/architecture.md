# Architecture

## Two tiers

**Tier A** is a single markdown file, `tier-a.md`, capped at ~5 KB. It is rebuilt deterministically from Tier B on every `refresh` and emitted by the SessionStart hook into Claude Code's context. It contains:
- Pinned decision cards (always included, never truncated by budget alone)
- A last-30d activity list
- A per-topic card-count summary

**Tier B** is an unbounded tree of markdown files under `tier-b/topics/<topic>/<id>.md`. One file = one decision. Fabricated example cards live in `examples/` and `tests/fixtures/`.

## Modules

| file              | role                                                        |
|-------------------|-------------------------------------------------------------|
| `src/card-shape.mjs` | parse and validate card frontmatter + body shape        |
| `src/compact.mjs`    | deterministic selection of cards into Tier A bytes      |
| `src/refresh.mjs`    | load Tier B, compact, write `tier-a.md`                 |
| `src/write-card.mjs` | create a new card from the template                     |
| `src/hygiene.mjs`    | scan a tree for real-user-content patterns              |
| `src/memory-cli.mjs` | top-level `memory` CLI dispatcher                       |
| `hooks/session-start.sh` | SessionStart hook wrapper                           |
| `scripts/install.sh` | bootstrap `$WORKING_MEMORY_ROOT` on a clean machine     |

## Determinism

`compact()` sorts cards by (pinned desc, created desc, id asc) before selection, so two consecutive runs on the same input produce byte-identical output. This is enforced by a test in `tests/compact.test.mjs`.

## Where real content lives

Never in this repo. Real cards live on disk at `$WORKING_MEMORY_ROOT` (default `$HOME/.claude/agent-working-memory/`) and — in later phases — are optionally backed by a private git remote. The public repo's `.gitignore` blocks `tier-b/topics/`, `tier-a.md`, and `*.card.md` so a developer running the tools from inside a clone cannot accidentally commit real decisions.

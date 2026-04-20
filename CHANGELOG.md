# Changelog

## [0.1.3](https://github.com/ziyilam3999/agent-working-memory/compare/v0.1.2...v0.1.3) (2026-04-20)

### Bug Fixes

* **hygiene:** scan tracked files only — `scanTree()` now sources file list from `git ls-files -z` when the root is a git repo, falling back to filesystem walk only for non-git roots (e.g. the seeded-probe test). Closes the local-dev-ergonomics gap where WIP scratch under `.ai-workspace/` could poison `npm test` even though the committed tree was clean ([#9](https://github.com/ziyilam3999/agent-working-memory/pull/9), closes [#8](https://github.com/ziyilam3999/agent-working-memory/issues/8))

## [0.1.2](https://github.com/ziyilam3999/agent-working-memory/compare/v0.1.1...v0.1.2) (2026-04-19)

### Bug Fixes

* **refresh:** guard `resolveRoot()` against unexpanded shell tokens (`$HOME`, `${HOME}`, `$WORKING_MEMORY_ROOT`) — throws with a token-naming error message instead of silently mis-routing writes ([#7](https://github.com/ziyilam3999/agent-working-memory/pull/7))

## [0.1.1](https://github.com/ziyilam3999/agent-working-memory/compare/v0.1.0...v0.1.1) (2026-04-16)

### Miscellaneous

- docs(plans): awm hook injection diagnosis, fix, and drift follow-up ([#1](https://github.com/ziyilam3999/agent-working-memory/pull/1))

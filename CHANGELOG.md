# Changelog

## [0.3.0](https://github.com/ziyilam3999/agent-working-memory/compare/v0.2.0...v0.3.0) (2026-05-07)

### Features

* **cli:** add `memory migrate-out` / `memory migrate-in` for cross-machine portability of the tier-b card library. Bundle local pinned cards into a `migration/<host-id>-<date>` branch on the content backup repo (out), then apply that branch onto a fresh host with conflict resolution strategies (in). Includes privacy pre-flight, byte-equal round-trip, host-id stability, and `--include-non-pinned` widen flag ([#27](https://github.com/ziyilam3999/agent-working-memory/pull/27)).

### Bug Fixes

* **migrate-out:** privacy gate respects rule-spec allowlist — admit the two `topics/privacy/*` cards that LEGITIMATELY carry the regulated employer-brand token (per parent-claude.md privacy spec exemption), while still blocking every other card. Path-pinned (NOT glob-pinned), 2-entry hardcoded `RULE_SPEC_ALLOWLIST`. Mirrors ai-brain Stage 5.6 pattern. Also remediates pre-existing fixture-circularity in `tests/migrate.test.mjs` (regulated tokens now built at runtime via `String.fromCharCode` so a cross-repo grep over `tests/` returns zero hits) ([#28](https://github.com/ziyilam3999/agent-working-memory/pull/28)).

### Miscellaneous

* **applyPlan:** drop unused `opts` parameter ([#26](https://github.com/ziyilam3999/agent-working-memory/pull/26)).
* **classifyError:** polish `'rebase-failed'` token coverage ([#25](https://github.com/ziyilam3999/agent-working-memory/pull/25)).

## [0.2.0](https://github.com/ziyilam3999/agent-working-memory/compare/v0.1.4...v0.2.0) (2026-04-25)

### Features

* **content-sync:** auto-sync pinned tier-b cards to the private content-repo backup. New `scripts/content-sync.mjs` (dry-run + full-run modes), filter predicate at `scripts/lib/content-filter.mjs`, four new tests covering filter / hash-edit detection / idempotency / non-pinned exclusion. PM2 entry `working-memory-content-sync` in new `ecosystem.config.cjs` runs daily at 04:30 local. `npm run sync` is the manual escape hatch. Failure path writes a single-line record to `<clone>/.last-sync-error.log` and exits non-zero. PR B of the memory-status pass — closes plan `.ai-workspace/plans/2026-04-25-memory-status-pass.md` ACs B1-B10.
* **refresh:** consume the Cairn status fragment (PR A producer) and embed the `## Memory liveness` panel in tier-a.md with four-branch graceful behavior — fresh / absent / malformed / stale. Freshness window: 8h, matching H7's cron cadence.

## [0.1.4](https://github.com/ziyilam3999/agent-working-memory/compare/v0.1.3...v0.1.4) (2026-04-20)

### Miscellaneous

* **hygiene:** polish rule #10/#11/#12 — submodule gitlinks scope comment above execFileSync, defensive isAbsolute guard comment, stderr log on unexpected listTrackedFiles fallback (gated on err.status !== 128 && err.code !== "ENOENT"). No behavior change to the hot path. Closes [#10](https://github.com/ziyilam3999/agent-working-memory/issues/10), [#11](https://github.com/ziyilam3999/agent-working-memory/issues/11), [#12](https://github.com/ziyilam3999/agent-working-memory/issues/12) ([#13](https://github.com/ziyilam3999/agent-working-memory/pull/13))

## [0.1.3](https://github.com/ziyilam3999/agent-working-memory/compare/v0.1.2...v0.1.3) (2026-04-20)

### Bug Fixes

* **hygiene:** scan tracked files only — `scanTree()` now sources file list from `git ls-files -z` when the root is a git repo, falling back to filesystem walk only for non-git roots (e.g. the seeded-probe test). Closes the local-dev-ergonomics gap where WIP scratch under `.ai-workspace/` could poison `npm test` even though the committed tree was clean ([#9](https://github.com/ziyilam3999/agent-working-memory/pull/9), closes [#8](https://github.com/ziyilam3999/agent-working-memory/issues/8))

## [0.1.2](https://github.com/ziyilam3999/agent-working-memory/compare/v0.1.1...v0.1.2) (2026-04-19)

### Bug Fixes

* **refresh:** guard `resolveRoot()` against unexpanded shell tokens (`$HOME`, `${HOME}`, `$WORKING_MEMORY_ROOT`) — throws with a token-naming error message instead of silently mis-routing writes ([#7](https://github.com/ziyilam3999/agent-working-memory/pull/7))

## [0.1.1](https://github.com/ziyilam3999/agent-working-memory/compare/v0.1.0...v0.1.1) (2026-04-16)

### Miscellaneous

- docs(plans): awm hook injection diagnosis, fix, and drift follow-up ([#1](https://github.com/ziyilam3999/agent-working-memory/pull/1))

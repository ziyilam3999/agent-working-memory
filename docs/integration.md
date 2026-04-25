# Integration notes

v0.1.0 is install-from-clone only. No package-registry publication. No automatic /ship wiring. Hook registration into Claude Code's global settings is manual — symlink `hooks/session-start.sh` from `$CLAUDE_CONFIG/hooks/SessionStart/` (or the equivalent path your Claude Code install uses).

## Manual hook registration (example shape)

The installer does not touch global settings. To register the SessionStart hook, add an entry to your Claude Code settings file that points at `hooks/session-start.sh` in this clone. See the parent plan's P3 section for the specific shape once that phase lands.

## Forward reference: P4 /ship integration

In a later phase, the `/ship` skill will call `memory write` after a successful merge so every shipped PR yields a decision card. That wiring is out of scope for v0.1.0 — the mechanism just has to exist and be stable enough to wire into.

## v0.2.0: content-repo auto-sync

Pinned tier-b cards are mirrored to a private GitHub backup repo so a fresh machine can rehydrate by cloning. The mirror is one-way (local to backup); the backup is never the source of truth. Source code at `scripts/content-sync.mjs`, filter predicate at `scripts/lib/content-filter.mjs`.

### What gets synced

Phase 1 of the card-tracking strategy: only **pinned** cards under `tier-b/topics/` are tracked. Non-pinned cards remain local-only. The filter predicate is intentionally narrow — broadening it is a future phase.

The dry-run mode previews the action plan without writing anything:

    node scripts/content-sync.mjs --dry-run

Each line is one of `ADD <path>`, `UPDATE <path>`, `DELETE <path>`, or `SKIP-FILTER <path> reason=<token>`. Output is sorted by path so two consecutive runs are byte-identical.

### Manual escape hatch

After pinning a card you want pushed immediately (rather than waiting for the next cron window):

    npm run sync

Same code path as the cron entry — one knob to learn.

### Cron schedule

PM2 entry in `ecosystem.config.cjs` runs the sync daily at 04:30 local. Activate once with:

    pm2 start ecosystem.config.cjs
    pm2 save

The cron expression is `30 4 * * *`, staggered after ai-brain's H5 (03:00) and H6 (Mon 04:00) so the daemon's cron storms do not all land on the same minute.

### Configuration

All env vars are optional; defaults match the production layout.

| Var | Default | Purpose |
|---|---|---|
| `WORKING_MEMORY_ROOT` | tier-b root under the user's Claude home | Source tier-b root |
| `CONTENT_REPO_CLONE` | content-repo-clone under the user's Claude home | Local clone of the backup repo |
| `CONTENT_REPO_REMOTE` | upstream HTTPS URL of the backup repo | Remote URL — overridable for tests |
| `CONTENT_REPO_BRANCH` | `main` | Target branch on the backup repo |
| `CONTENT_SYNC_SKIP_PUSH` | unset | Set to `1` to skip the push step (useful when the remote is down) |
| `CONTENT_SYNC_AUTHOR_NAME` | (uses git global) | Override commit author name |
| `CONTENT_SYNC_AUTHOR_EMAIL` | (uses git global) | Override commit author email |

### Bootstrap order on a fresh machine

ai-brain's PM2 ecosystem (`cairn-h4`, `cairn-h5`, `cairn-h6`, `cairn-h7`) should start before agent-working-memory's. H7 fires every 6h and writes the Cairn status fragment to the user's Claude home. The SessionStart hook in this repo embeds that fragment in tier-a.md when present, falling back gracefully when absent — so a session that starts before the first H7 fire will not see the memory-liveness panel until ~6h after Cairn comes up. The auto-sync cron itself does not depend on the fragment.

### Failure observability

When the sync hits an unrecoverable error (network, auth, push rejection that exhausted the rebase retry budget), the script:

1. Exits with code 1.
2. Writes a single-line failure record to `<CONTENT_REPO_CLONE>/.last-sync-error.log` carrying timestamp + error class. The file is overwritten each run (last-error-only — operators tail the file rather than scroll history).

The retry budget for `git pull --rebase` collisions is 3 attempts. After the budget is exhausted the script gives up and surfaces the failure record.

### How to disable

    pm2 stop working-memory-content-sync
    pm2 delete working-memory-content-sync

The repo on disk and any committed cards are untouched; only the cron entry is removed.

## Memory-liveness panel in tier-a

`src/refresh.mjs` consumes the Cairn status fragment (default path under the user's Claude home, overridable via `CAIRN_STATUS_FRAGMENT`) and embeds the `## Memory liveness` panel at the bottom of tier-a.md. Four-branch graceful behavior:

- **fresh** (anchor present, mtime within 8h) — panel embedded as-is
- **absent** (file missing) — tier-a is unchanged
- **malformed** (anchor missing) — tier-a carries a single `_memory-liveness: malformed_` note
- **stale** (anchor present, mtime > 8h) — panel embedded WITH age annotation in the heading

The 8h freshness window matches the H7 cron cadence's freshness window in ai-brain's `cairn/lib/heartbeat-reader.mjs`.

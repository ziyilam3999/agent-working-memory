# Integration notes

v0.1.0 is install-from-clone only. No package-registry publication. No automatic /ship wiring. Hook registration into Claude Code's global settings is manual — symlink `hooks/session-start.sh` from `$CLAUDE_CONFIG/hooks/SessionStart/` (or the equivalent path your Claude Code install uses).

## Manual hook registration (example shape)

The installer does not touch global settings. To register the SessionStart hook, add an entry to your Claude Code settings file that points at `hooks/session-start.sh` in this clone. See the parent plan's P3 section for the specific shape once that phase lands.

## Forward reference: P4 /ship integration

In a later phase, the `/ship` skill will call `memory write` after a successful merge so every shipped PR yields a decision card. That wiring is out of scope for v0.1.0 — the mechanism just has to exist and be stable enough to wire into.

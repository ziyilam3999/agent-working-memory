# content-sync test fixtures

Tests under `tests/content-sync.test.mjs` build their tier-b layouts inline
in tmp dirs so each case is hermetic (the worktree's tier-b is git-ignored
anyway). This directory exists so the path referenced in the PR plan's B9
file-touch allowlist resolves on disk; it carries no test data of its own.

# Contributing

Thanks for your interest in contributing to `agent-working-memory`.

## Before you start

- Open an issue first for non-trivial changes so scope can be discussed before code is written
- Check existing issues and PRs to avoid duplicate work

## Development

Requires Node.js 18+.

```bash
git clone https://github.com/ziyilam3999/agent-working-memory.git
cd agent-working-memory
npm install
npm test
```

The test suite uses `node --test` and lives in `tests/*.test.mjs`.

## Proposing a change

1. Create a branch: `git checkout -b feat/short-description`
2. Make focused commits (conventional-commit prefixes preferred: `feat:`, `fix:`, `docs:`, `chore:`)
3. Add or update tests for any behavior change
4. Push and open a PR
5. CI runs against Node 18 and 20 — both must pass

## Style

- Keep each PR focused on one concern
- Match the existing code style (ESM, plain JS / `.mjs`, no TypeScript)
- Update README or `docs/` when user-facing behavior changes

## License

By contributing, you agree your contributions are licensed under the MIT License (see `LICENSE`).

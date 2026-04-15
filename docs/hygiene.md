# Hygiene policy

This is a **public** repository. It must contain **zero** real user content. The hygiene scanner (`src/hygiene.mjs`) enforces this mechanically by scanning every committed file for forbidden patterns.

## Forbidden patterns

| pattern name          | example shape                                 |
|-----------------------|-----------------------------------------------|
| windows-user-path     | `C:\Users\someone\...`                        |
| posix-home-path       | `/home/someone/...` or `/Users/someone/...`   |
| claude-home-ref       | `~/.claude/...` (identifies a user install)   |
| email                 | anything matching `name@domain.tld`           |
| github-token          | `ghp_...`, `gho_...`, `ghu_...`, etc          |
| openai-token          | `sk-...`                                      |
| slack-token           | `xoxb-...`, `xoxp-...`                        |
| bearer-hex            | `Bearer <32+ hex chars>`                      |

## Allowlist

The scanner allows a small set of files to mention these patterns for documentation and testing purposes:

- `src/hygiene.mjs` — the scanner itself defines the patterns
- `tests/hygiene.test.mjs` — tests the scanner against seeded violations
- `docs/hygiene.md` — this file, which documents the patterns
- `scripts/p1-acceptance.sh` — the acceptance wrapper seeds a violation to probe AC-3
- `README.md` — top-level install docs reference path shapes

No other file may mention these patterns. If you need to add a new allowlist entry, do so in `src/hygiene.mjs` AND explain why in a commit message.

## Running the scanner

```bash
npm run hygiene        # scans the whole repo
node src/hygiene.mjs . # equivalent direct invocation
```

Exit 0 = clean. Exit 1 = one or more violations (file:line:pattern printed to stderr).

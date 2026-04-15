---
id: use-esm
topic: architecture
title: use ESM across the codebase
created: 2026-04-01
pinned: true
tags: [module-system]
---

## Decision
Use ESM (`.mjs`, `"type": "module"`) throughout the project.

## Context
Consistent module system across src, tests, and hooks reduces surprise.

## Consequences
Requires Node 18+. CommonJS modules cannot be imported without a wrapper.

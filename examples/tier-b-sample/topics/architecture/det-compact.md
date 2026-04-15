---
id: det-compact
topic: architecture
title: deterministic compaction
created: 2026-04-05
pinned: false
tags: [algorithm]
---

## Decision
v1 compaction is deterministic: pinned + last-30d + topic counts. No LLM.

## Context
LLM-based selection introduces run-to-run churn and requires an API dependency at session start.

## Consequences
Output is byte-identical across consecutive runs on the same input.

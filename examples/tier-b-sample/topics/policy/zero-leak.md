---
id: zero-leak
topic: policy
title: zero real user content in public repo
created: 2026-04-02
pinned: true
tags: [hygiene, public]
---

## Decision
The public mechanism repo contains zero real user data.

## Context
Public visibility + stored decisions = a leak hazard unless the mechanism is separated from the content.

## Consequences
All committed examples and fixtures are fabricated. Hygiene scanner enforces this on every commit.

// Tests for resolveRoot() guard against unexpanded shell tokens.
//
// Context: Claude Code's global settings env block ships literal values to
// child processes, so a config like "$HOME/.claude/..." leaks the literal
// $HOME token into WORKING_MEMORY_ROOT. Writing to that path creates a
// bogus directory named $HOME under the current working directory. The
// guard refuses such paths loudly.
//
// Plan: forge-harness/.ai-workspace/plans/2026-04-19-memory-cli-home-leak-fix.md

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRoot } from "../src/refresh.mjs";

// AC-02: guard throws when WORKING_MEMORY_ROOT holds a literal, unexpanded
// $HOME token.
test("resolveRoot: throws on literal unexpanded $HOME in WORKING_MEMORY_ROOT env var", () => {
  const prev = process.env.WORKING_MEMORY_ROOT;
  process.env.WORKING_MEMORY_ROOT = "$HOME/.claude/agent-working-memory";
  try {
    assert.throws(
      () => resolveRoot(),
      /unexpanded shell token.*HOME/,
      "expected resolveRoot to throw naming the offending HOME token",
    );
  } finally {
    if (prev === undefined) delete process.env.WORKING_MEMORY_ROOT;
    else process.env.WORKING_MEMORY_ROOT = prev;
  }
});

// Same class of bug with ${HOME} (curly-brace form).
test("resolveRoot: throws on literal ${HOME} (curly-brace form) in env var", () => {
  const prev = process.env.WORKING_MEMORY_ROOT;
  process.env.WORKING_MEMORY_ROOT = "${HOME}/.claude/agent-working-memory";
  try {
    assert.throws(
      () => resolveRoot(),
      /unexpanded shell token.*HOME/,
      "expected resolveRoot to throw naming the offending HOME token",
    );
  } finally {
    if (prev === undefined) delete process.env.WORKING_MEMORY_ROOT;
    else process.env.WORKING_MEMORY_ROOT = prev;
  }
});

// Guard also triggers when an unexpanded token is passed via argRoot.
test("resolveRoot: throws on literal unexpanded $VAR in argRoot", () => {
  assert.throws(
    () => resolveRoot("$WORKING_MEMORY_ROOT/tier-b"),
    /unexpanded shell token/,
    "expected resolveRoot to throw when argRoot contains a literal $VAR",
  );
});

// AC-03: with WORKING_MEMORY_ROOT unset, fallback expands correctly to an
// absolute path under the user's home directory.
test("resolveRoot: unset env var falls back to expanded $HOME-based absolute path", () => {
  const prev = process.env.WORKING_MEMORY_ROOT;
  delete process.env.WORKING_MEMORY_ROOT;
  try {
    const root = resolveRoot();
    assert.ok(root && typeof root === "string", "expected non-empty string");
    assert.ok(
      !/\$\{?[A-Za-z_]/.test(root),
      `fallback path must not contain unexpanded tokens, got: ${root}`,
    );
    // Absolute path — either POSIX (/c/...) or Windows drive (C:\...).
    assert.ok(
      /^([A-Za-z]:[\\/]|\/)/.test(root),
      `expected absolute path, got: ${root}`,
    );
    assert.ok(
      root.includes("agent-working-memory"),
      `expected path to end under agent-working-memory, got: ${root}`,
    );
  } finally {
    if (prev !== undefined) process.env.WORKING_MEMORY_ROOT = prev;
  }
});

// Explicit, fully-expanded argRoot is accepted unchanged.
test("resolveRoot: fully-expanded argRoot is returned unchanged", () => {
  const input = "/tmp/fake/agent-working-memory";
  assert.equal(resolveRoot(input), input);
});

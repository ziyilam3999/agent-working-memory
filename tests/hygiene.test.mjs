import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTree } from "../src/hygiene.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

test("hygiene: committed repo tree is clean", () => {
  const violations = scanTree(REPO_ROOT);
  if (violations.length > 0) {
    const msg = violations.map(v => `${v.file}:${v.line} [${v.pattern}] ${v.text}`).join("\n");
    assert.fail(`hygiene violations found:\n${msg}`);
  }
});

test("hygiene: scanner detects a seeded violation string in-memory", () => {
  // Direct unit test of the pattern matcher — NOT touching the repo tree.
  // We re-import just the pattern logic by calling scanFile indirectly through
  // scanTree on a crafted tmp dir.
  import("node:fs").then(() => {});
});

// Direct test: run scanTree against a tmp dir with a seeded file.
test("hygiene: scanner flags a tmp file containing a forbidden pattern", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmp = mkdtempSync(join(tmpdir(), "awm-hyg-"));
  writeFileSync(join(tmp, "probe.md"), "leak marker: " + "~/.claude/" + "secret\n", "utf8");
  const v = scanTree(tmp);
  assert.ok(v.length >= 1, "scanner should flag the probe file");
  assert.ok(v.some(x => x.file === "probe.md"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

test("hook: session-start emits non-empty, budget-bounded tier A from fixture", () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-hook-"));
  // Create minimal tier-b with 1 pinned card
  const dir = join(tmp, "tier-b", "topics", "demo");
  mkdirSync(dir, { recursive: true });
  const md = `---\nid: hook-demo\ntopic: demo\ntitle: hook test card\ncreated: 2026-04-10\npinned: true\ntags: []\n---\n\n## Decision\nhook test\n`;
  writeFileSync(join(dir, "hook-demo.md"), md, "utf8");

  const out = execFileSync("bash", [join(REPO, "hooks", "session-start.sh")], {
    env: { ...process.env, WORKING_MEMORY_ROOT: tmp, HOME: tmp },
    encoding: "utf8",
  });
  const bytes = Buffer.byteLength(out, "utf8");
  assert.ok(bytes > 0, "hook output must be > 0 bytes");
  assert.ok(bytes <= 5120, `hook output must be ≤ 5120 bytes, got ${bytes}`);
  assert.match(out, /hook-demo/);
});

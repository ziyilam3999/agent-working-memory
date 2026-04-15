import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

test("installer: creates expected subtree under fake HOME", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "awm-home-"));
  execFileSync("bash", [join(REPO, "scripts", "install.sh")], {
    env: { ...process.env, HOME: fakeHome, WORKING_MEMORY_ROOT: "" },
    encoding: "utf8",
  });
  const root = join(fakeHome, ".claude", "agent-working-memory");
  assert.ok(existsSync(join(root, "tier-b", "topics")), "tier-b/topics missing");
  assert.ok(existsSync(join(root, "tier-a.md")), "tier-a.md missing");
});

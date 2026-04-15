import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCard } from "../src/card-shape.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

test("card-shape: 3 valid cards classified valid", () => {
  const dir = join(FIXTURES, "valid");
  const files = readdirSync(dir).filter(f => f.endsWith(".md"));
  assert.equal(files.length, 3, "expected 3 valid fixtures");
  for (const f of files) {
    const res = validateCard(readFileSync(join(dir, f), "utf8"));
    assert.equal(res.valid, true, `${f} should be valid, errors=${res.errors?.join(",")}`);
  }
});

test("card-shape: 3 invalid cards classified invalid", () => {
  const dir = join(FIXTURES, "invalid");
  const files = readdirSync(dir).filter(f => f.endsWith(".md"));
  assert.equal(files.length, 3, "expected 3 invalid fixtures");
  for (const f of files) {
    const res = validateCard(readFileSync(join(dir, f), "utf8"));
    assert.equal(res.valid, false, `${f} should be invalid`);
    assert.ok(res.errors.length > 0, `${f} should have errors`);
  }
});

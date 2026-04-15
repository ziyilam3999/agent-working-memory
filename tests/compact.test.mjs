import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCards, compact, sortCards } from "../src/compact.mjs";

// Build a fabricated tier-b fixture with:
//   - 3 topics: alpha, beta, gamma
//   - 2 pinned cards
//   - 6 cards within the last 30 days (relative to fixedNow)
//   - 20+ cards total
function buildFixture(root, fixedNow) {
  const base = new Date(fixedNow);
  const daysAgo = n => {
    const d = new Date(base.getTime() - n * 86400000);
    return d.toISOString().slice(0, 10);
  };
  const cards = [
    // pinned
    { topic: "alpha", id: "a-pin-1", pinned: true, created: daysAgo(200), title: "alpha pin 1" },
    { topic: "beta", id: "b-pin-1", pinned: true, created: daysAgo(100), title: "beta pin 1" },
    // last-30d (6)
    { topic: "alpha", id: "a-recent-1", pinned: false, created: daysAgo(1), title: "alpha r1" },
    { topic: "alpha", id: "a-recent-2", pinned: false, created: daysAgo(5), title: "alpha r2" },
    { topic: "beta", id: "b-recent-1", pinned: false, created: daysAgo(10), title: "beta r1" },
    { topic: "beta", id: "b-recent-2", pinned: false, created: daysAgo(15), title: "beta r2" },
    { topic: "gamma", id: "g-recent-1", pinned: false, created: daysAgo(20), title: "gamma r1" },
    { topic: "gamma", id: "g-recent-2", pinned: false, created: daysAgo(25), title: "gamma r2" },
    // old non-pinned padding (>30d)
    ...Array.from({ length: 15 }, (_, i) => ({
      topic: ["alpha", "beta", "gamma"][i % 3],
      id: `old-${i}`,
      pinned: false,
      created: daysAgo(60 + i),
      title: `old card ${i}`,
    })),
  ];

  for (const c of cards) {
    const dir = join(root, "topics", c.topic);
    mkdirSync(dir, { recursive: true });
    const md = `---\nid: ${c.id}\ntopic: ${c.topic}\ntitle: ${c.title}\ncreated: ${c.created}\npinned: ${c.pinned}\ntags: []\n---\n\n## Decision\n${c.title}\n`;
    writeFileSync(join(dir, `${c.id}.md`), md, "utf8");
  }
  return cards.length;
}

test("compact: includes all pinned and stays within budget", () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-compact-"));
  const now = new Date("2026-04-15T00:00:00Z");
  const total = buildFixture(tmp, now);
  assert.ok(total >= 20);

  const cards = loadCards(tmp);
  assert.equal(cards.length, total);

  const out = compact(cards, { budget: 5120, now });
  assert.ok(out.length <= 5120, `output exceeded budget: ${out.length}`);

  // all pinned present
  assert.match(out, /a-pin-1/);
  assert.match(out, /b-pin-1/);

  // ≥3 topics represented in topic summary
  assert.match(out, /alpha:/);
  assert.match(out, /beta:/);
  assert.match(out, /gamma:/);
});

test("compact: is deterministic across runs (identical bytes)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "awm-compact-det-"));
  const now = new Date("2026-04-15T00:00:00Z");
  buildFixture(tmp, now);
  const cards = loadCards(tmp);
  const a = compact(cards, { budget: 5120, now });
  const b = compact(cards, { budget: 5120, now });
  assert.equal(a, b);
});

test("compact: sortCards places pinned first then created desc", () => {
  const inCards = [
    { id: "z", topic: "t", created: "2026-01-01", pinned: false, title: "" },
    { id: "a", topic: "t", created: "2026-02-01", pinned: true, title: "" },
    { id: "b", topic: "t", created: "2026-01-15", pinned: false, title: "" },
  ];
  const sorted = sortCards(inCards);
  assert.equal(sorted[0].id, "a");
  assert.equal(sorted[1].id, "b");
  assert.equal(sorted[2].id, "z");
});

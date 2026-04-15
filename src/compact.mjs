// Compact: deterministic selection of Tier B cards into a bounded Tier A string.
// Rules (v1, deterministic — no LLM):
//   1. ALL pinned cards are included (no truncation of pinned).
//   2. Then cards from the last 30 days, newest first.
//   3. Then a per-topic summary line (one line per topic with count).
//   4. Output is truncated at BUDGET bytes by dropping trailing non-pinned items.
// Determinism: input cards are sorted by (pinned desc, created desc, id asc) before selection
// so two consecutive runs on the same input produce identical bytes.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseCard } from "./card-shape.mjs";

export const DEFAULT_BUDGET = 5120;

export function loadCards(tierBRoot) {
  const out = [];
  const topicsDir = join(tierBRoot, "topics");
  let topics;
  try { topics = readdirSync(topicsDir); } catch { return out; }
  for (const topic of topics.sort()) {
    const topicDir = join(topicsDir, topic);
    let entries;
    try { entries = readdirSync(topicDir); } catch { continue; }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      const full = join(topicDir, entry);
      let text;
      try { text = readFileSync(full, "utf8"); } catch { continue; }
      const parsed = parseCard(text);
      if (!parsed.ok) continue;
      out.push({
        id: parsed.front.id || entry.replace(/\.md$/, ""),
        topic: parsed.front.topic || topic,
        created: parsed.front.created || "0000-00-00",
        pinned: parsed.front.pinned === "true",
        title: (parsed.front.title || parsed.front.id || entry).replace(/\s+/g, " "),
        path: full,
      });
    }
  }
  return out;
}

export function sortCards(cards) {
  return [...cards].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.created !== b.created) return a.created > b.created ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function isRecent(createdStr, now = new Date(), days = 30) {
  const d = new Date(createdStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return false;
  const diff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= days;
}

export function compact(cards, { budget = DEFAULT_BUDGET, now = new Date() } = {}) {
  const sorted = sortCards(cards);
  const pinned = sorted.filter(c => c.pinned);
  const recent = sorted.filter(c => !c.pinned && isRecent(c.created, now));

  // Per-topic counts (deterministic order: topic asc)
  const topicCounts = {};
  for (const c of sorted) topicCounts[c.topic] = (topicCounts[c.topic] || 0) + 1;
  const topicLines = Object.keys(topicCounts).sort()
    .map(t => `- ${t}: ${topicCounts[t]} card(s)`);

  const header = "# Tier A — Pocket Card\n\n";
  const pinnedSection = pinned.length
    ? "## Pinned\n" + pinned.map(c => `- [${c.topic}] ${c.title} (${c.id})`).join("\n") + "\n\n"
    : "";
  const recentHeader = "## Recent (last 30d)\n";
  const topicHeader = "\n## Topics\n" + topicLines.join("\n") + "\n";

  // Build body, appending recent lines one at a time until we near budget.
  // Pinned + header + topic summary must always fit.
  const fixed = header + pinnedSection + recentHeader;
  const tail = topicHeader;
  let body = "";
  for (const c of recent) {
    const line = `- [${c.topic}] ${c.title} (${c.id}, ${c.created})\n`;
    if ((fixed + body + line + tail).length > budget) break;
    body += line;
  }
  let out = fixed + body + tail;
  // Final hard cap: if pinned alone already exceeds budget, truncate at budget.
  if (out.length > budget) out = out.slice(0, budget);
  return out;
}

// Write a new Tier B decision card.
// Usage:
//   node src/write-card.mjs --topic TOPIC --id ID --title TITLE [--pinned] [--root PATH]
// Writes to $root/tier-b/topics/$topic/$id.md using templates/decision-card.md as the shape.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoot } from "./refresh.mjs";
import { validateCard } from "./card-shape.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, "..", "templates", "decision-card.md");

export function buildCard({ id, topic, title, pinned = false, created, body = "" }) {
  const createdStr = created || new Date().toISOString().slice(0, 10);
  const tmpl = existsSync(TEMPLATE_PATH) ? readFileSync(TEMPLATE_PATH, "utf8") : DEFAULT_TEMPLATE;
  return tmpl
    .replaceAll("{{id}}", id)
    .replaceAll("{{topic}}", topic)
    .replaceAll("{{title}}", title)
    .replaceAll("{{pinned}}", String(pinned))
    .replaceAll("{{created}}", createdStr)
    .replaceAll("{{body}}", body || "Describe the decision here.");
}

const DEFAULT_TEMPLATE = `---
id: {{id}}
topic: {{topic}}
title: {{title}}
created: {{created}}
pinned: {{pinned}}
tags: []
---

## Decision
{{body}}

## Context
(what prompted this)

## Consequences
(what this unlocks or locks in)
`;

export function writeCard(opts) {
  const root = opts.root || resolveRoot();
  const card = buildCard(opts);
  const v = validateCard(card);
  if (!v.valid) throw new Error("generated card failed validation: " + v.errors.join(", "));
  const dir = join(root, "tier-b", "topics", opts.topic);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${opts.id}.md`);
  writeFileSync(path, card, "utf8");
  return path;
}

function parseArgs(argv) {
  const out = { pinned: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--topic") out.topic = argv[++i];
    else if (a === "--id") out.id = argv[++i];
    else if (a === "--title") out.title = argv[++i];
    else if (a === "--pinned") out.pinned = true;
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--body") out.body = argv[++i];
  }
  return out;
}

if (process.argv[1]?.endsWith("write-card.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.topic || !args.id || !args.title) {
    process.stderr.write("usage: write-card --topic T --id I --title S [--pinned] [--root R]\n");
    process.exit(2);
  }
  const path = writeCard(args);
  process.stdout.write(`wrote ${path}\n`);
}

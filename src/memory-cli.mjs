#!/usr/bin/env node
// Top-level `memory` CLI dispatcher.
// Subcommands: refresh, compact, write, hygiene, help

import { refresh, resolveRoot } from "./refresh.mjs";
import { writeCard } from "./write-card.mjs";
import { scanTree } from "./hygiene.mjs";
import { loadCards, compact } from "./compact.mjs";
import { join } from "node:path";

const [, , sub, ...rest] = process.argv;

function help() {
  process.stdout.write(`memory — agent working memory CLI

subcommands:
  refresh [--root R] [--budget N]   rebuild tier-a.md from tier-b tree
  compact [--root R] [--budget N]   print compacted tier-a to stdout (no write)
  write --topic T --id I --title S [--pinned] [--root R]
                                    create a new tier-b card
  hygiene [ROOT]                    scan ROOT for hygiene violations (default .)
  help                              show this message
`);
}

function parseKV(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = (argv[i + 1] && !argv[i + 1].startsWith("--")) ? argv[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

try {
  switch (sub) {
    case "refresh": {
      const kv = parseKV(rest);
      const root = resolveRoot(kv.root);
      const res = refresh({ root, budget: kv.budget ? parseInt(kv.budget, 10) : undefined });
      process.stdout.write(`refreshed ${res.outPath} (${res.bytes} bytes, ${res.cardCount} cards)\n`);
      break;
    }
    case "compact": {
      const kv = parseKV(rest);
      const root = resolveRoot(kv.root);
      const cards = loadCards(join(root, "tier-b"));
      const out = compact(cards, { budget: kv.budget ? parseInt(kv.budget, 10) : undefined });
      process.stdout.write(out);
      break;
    }
    case "write": {
      const kv = parseKV(rest);
      if (!kv.topic || !kv.id || !kv.title) {
        process.stderr.write("write: --topic, --id, --title required\n");
        process.exit(2);
      }
      const path = writeCard({
        topic: kv.topic, id: kv.id, title: kv.title,
        pinned: kv.pinned === "true", root: kv.root, body: kv.body,
      });
      process.stdout.write(`wrote ${path}\n`);
      break;
    }
    case "hygiene": {
      const root = rest[0] || process.cwd();
      const v = scanTree(root);
      if (v.length === 0) { process.stdout.write("hygiene: clean\n"); break; }
      for (const x of v) process.stderr.write(`${x.file}:${x.line} [${x.pattern}]\n`);
      process.exit(1);
    }
    case undefined:
    case "help":
    case "-h":
    case "--help":
      help(); break;
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n`);
      help();
      process.exit(2);
  }
} catch (e) {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
}

// Card-shape validator.
// A valid decision card is a markdown file with YAML-ish frontmatter containing:
//   id (string), topic (string), created (YYYY-MM-DD), pinned (bool), tags (list)
// followed by a body with at least one "## Decision" section.

export function parseCard(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { ok: false, reason: "missing frontmatter" };
  const front = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (mm) front[mm[1]] = mm[2].trim();
  }
  return { ok: true, front, body: m[2] };
}

export function validateCard(text) {
  const errors = [];
  const parsed = parseCard(text);
  if (!parsed.ok) return { valid: false, errors: [parsed.reason] };
  const { front, body } = parsed;

  if (!front.id) errors.push("missing id");
  if (!front.topic) errors.push("missing topic");
  if (!front.created) {
    errors.push("missing created");
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(front.created)) {
    errors.push("created not YYYY-MM-DD");
  }
  if (front.pinned === undefined) errors.push("missing pinned");
  else if (!/^(true|false)$/.test(front.pinned)) errors.push("pinned not bool");
  if (!/^##\s+Decision\b/m.test(body)) errors.push("missing ## Decision section");

  return { valid: errors.length === 0, errors };
}

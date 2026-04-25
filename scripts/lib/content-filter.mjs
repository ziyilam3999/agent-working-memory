// Content-filter predicate.
//
// Decides which tier-b cards belong in the public-but-private content-repo
// backup. Phase 1 of the card-tracking strategy: only PINNED cards under
// `tier-b/topics/` are tracked. Non-pinned cards stay local-only until a
// future phase introduces middle-ground triage.
//
// Inputs:
//   - relPath: tier-b-relative path of a card file (e.g.
//     "topics/memory-architecture/2026-04-15-foo.md"). Forward-slash
//     separators expected; callers normalize before calling.
//   - parsed: result of parseCard(text) from src/card-shape.mjs. The filter
//     reads parsed.front.pinned only (string "true"/"false") so it remains
//     decoupled from the validator's evolving schema.
//
// Output: { included: boolean, reason: string }
//   reason is a short machine-readable token suitable for dry-run output:
//     "pinned"            — included
//     "non-pinned"        — excluded (most common reason)
//     "not-card"          — excluded (frontmatter parse failed)
//     "outside-topics"    — excluded (path is not under topics/)
//     "non-md"            — excluded (path doesn't end .md)
//
// Determinism: pure function. No I/O. No clock.

const TOPICS_PREFIX = "topics/";

export function shouldInclude(relPath, parsed) {
  if (!relPath.endsWith(".md")) {
    return { included: false, reason: "non-md" };
  }
  if (!relPath.startsWith(TOPICS_PREFIX)) {
    return { included: false, reason: "outside-topics" };
  }
  if (!parsed || !parsed.ok) {
    return { included: false, reason: "not-card" };
  }
  const pinned = parsed.front && parsed.front.pinned === "true";
  if (!pinned) {
    return { included: false, reason: "non-pinned" };
  }
  return { included: true, reason: "pinned" };
}

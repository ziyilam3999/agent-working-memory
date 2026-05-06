// Privacy denylist: regex patterns for regulated tokens that must NEVER
// appear in cards bound for a public-facing artefact (PR body, commit
// message, branch on the content backup repo, etc.).
//
// Provenance:
//   - parent-claude.md "## Privacy & Employer-Brand Hygiene" — hard rule
//     (added 2026-04-17): never write the user's current employer's brand
//     name (or common spellings / variants), or any award / specific metric
//     that single-sources that employer.
//   - per-project Claude memory feedback card "no_employer_mention" — the
//     concrete substitutes / variants list (bare brand, brand+qualifier
//     forms, single-source award metric).
//   - Plan §"Privacy denylist seam" (2026-05-05) — case-insensitive,
//     covers brand variants + common spellings; AC-9b mandates a separate
//     test case for the variant surface.
//
// Per the plan: this module is the FIRST callable artefact derived from
// the prose privacy spec. AC-9b consumers (migrate-out pre-flight; future
// /ship adoption) should grep across all candidate text using these
// patterns and refuse to ship on any match.
//
// Patterns are case-insensitive (the `i` flag) and use word-boundary or
// equivalent gating to avoid false positives on substrings of unrelated
// English words. Variant coverage:
//   - Bare brand:         UOB
//   - Brand + qualifier:  UOB Bank, UOB Group, UOB Mighty
//   - Spaced variants:    "U O B", "U.O.B." (common typo / acronym
//                         expansion forms)
//   - Single-source award metric: "Best Foreign Bank in Malaysia
//                                  (Asian Banker ...)"
//
// NOT included here (intentional out-of-scope):
//   - Project-internal codenames that don't single-source the employer
//     ("Customer Onboarding MY/SG", "Online Fraud Management", etc.) — the
//     privacy spec explicitly carves these out.
//   - Adjacent-employer names (e.g., "CIMB" — was an agency client via
//     VMLY&R, not the user's employer; mention is permitted per the spec).
//
// Determinism: pure module. No I/O. Patterns are frozen at import time.

// Each entry is { name, pattern } so callers can render a meaningful
// reject reason (e.g., "PRIVACY-BLOCK pattern=brand-bare").
export const DENYLIST_PATTERNS = Object.freeze([
  // Bare brand token. \b on both sides so "uobiquitous" wouldn't match —
  // (purely defensive; not a real word, but the gate matters for any
  // future English text that happens to contain "uob" mid-word).
  { name: "brand-bare", pattern: /\bUOB\b/i },
  // Brand + qualifier — the explicit forms in the privacy spec.
  { name: "brand-bank", pattern: /\bUOB\s+Bank\b/i },
  { name: "brand-group", pattern: /\bUOB\s+Group\b/i },
  { name: "brand-mighty", pattern: /\bUOB\s+Mighty\b/i },
  // Geographic-qualifier forms ("UOB Malaysia", "UOB Singapore").
  { name: "brand-region", pattern: /\bUOB\s+(Malaysia|Singapore|Indonesia|Thailand|Vietnam)\b/i },
  // Spaced acronym variant ("U O B", "U.O.B."). \b around capital
  // U because the acronym is capitalized in all observed forms; the `i`
  // flag still allows lowercase matches.
  { name: "brand-spaced", pattern: /\bU[\s.][\s.]?O[\s.][\s.]?B\b/i },
  // Single-source award identifier from the privacy spec.
  { name: "award-best-foreign-bank-my", pattern: /Best\s+Foreign\s+Bank\s+in\s+Malaysia/i },
]);

/**
 * Scan a string for any denylist match. Returns the FIRST match found
 * (deterministic: walks DENYLIST_PATTERNS in declaration order).
 * Returns null if no match.
 *
 * @param {string} text
 * @returns {{ name: string, match: string } | null}
 */
export function findFirstMatch(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  for (const { name, pattern } of DENYLIST_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return { name, match: m[0] };
  }
  return null;
}

/**
 * Scan a string for ALL denylist matches. Useful for surfacing every
 * regulated token in a single error message rather than fix-one-at-a-time.
 *
 * @param {string} text
 * @returns {Array<{ name: string, match: string }>}
 */
export function findAllMatches(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const out = [];
  for (const { name, pattern } of DENYLIST_PATTERNS) {
    // Build a global variant for exhaustive scan; preserve case-insensitivity.
    const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
    const gpattern = new RegExp(pattern.source, flags);
    let m;
    while ((m = gpattern.exec(text)) !== null) {
      out.push({ name, match: m[0] });
      if (m[0].length === 0) gpattern.lastIndex++; // safety against zero-width
    }
  }
  return out;
}

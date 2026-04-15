#!/usr/bin/env bash
# Plan-mandated acceptance wrapper for P1.
# Runs every AC (AC-1 through AC-10) in order and exits 0 iff all pass.
#
# Usage:
#   bash scripts/p1-acceptance.sh            # runs local checks only (skips AC-1)
#   AC1=1 bash scripts/p1-acceptance.sh      # includes AC-1 (needs repo pushed + tag)
#
# AC-1 (GitHub repo visibility/license/tag) is gated on an env var so the wrapper
# can be run locally before the repo is created. The final pre-tag self-check run
# sets AC1=0; the post-tag run sets AC1=1.

export MSYS_NO_PATHCONV=1
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
declare -a RESULTS

record() {
  local name="$1" status="$2" detail="$3"
  RESULTS+=("$name | $status | $detail")
  if [ "$status" = "PASS" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
}

line() { printf '%s\n' "------------------------------------------------------------"; }

line
echo "P1 acceptance wrapper (repo: $REPO_ROOT)"
line

# ---- AC-2: fresh clone + npm test ----
echo "[AC-2] fresh-clone + npm test"
AC2_TMP="$(mktemp -d)"
if [ -d "$REPO_ROOT/.git" ]; then
  if git clone -q "$REPO_ROOT" "$AC2_TMP/awm-clone" 2>&1; then
    if ( cd "$AC2_TMP/awm-clone" && (npm ci 2>/dev/null || npm install 2>/dev/null) && npm test ) >"$AC2_TMP/out.log" 2>&1; then
      record "AC-2" "PASS" "fresh clone npm test exit 0"
    else
      record "AC-2" "FAIL" "npm test failed; log: $AC2_TMP/out.log"
      tail -40 "$AC2_TMP/out.log" || true
    fi
  else
    record "AC-2" "FAIL" "git clone failed"
  fi
else
  record "AC-2" "FAIL" "no .git in REPO_ROOT"
fi

# ---- AC-3: hygiene probe ----
echo "[AC-3] hygiene-probe seeded-violation test"
PROBE="$REPO_ROOT/examples/_probe.md"
# Seed the forbidden pattern via printf to avoid literal source in this script
printf '%s\n' "leak: $(printf '~/.claude/secret')" > "$PROBE"
if ( cd "$REPO_ROOT" && npm test ) >/tmp/ac3.log 2>&1; then
  record "AC-3" "FAIL" "npm test passed with seeded violation (hygiene is a no-op)"
else
  if grep -q "_probe" /tmp/ac3.log; then
    record "AC-3" "PASS" "npm test failed and named _probe"
  else
    record "AC-3" "FAIL" "npm test failed but did not name _probe"
    tail -40 /tmp/ac3.log || true
  fi
fi
rm -f "$PROBE"

# ---- AC-4: installer against fake HOME ----
echo "[AC-4] installer creates expected subtree"
FAKE_HOME="$(mktemp -d)"
if HOME="$FAKE_HOME" WORKING_MEMORY_ROOT="" bash "$REPO_ROOT/scripts/install.sh" >/dev/null 2>&1; then
  if [ -d "$FAKE_HOME/.claude/agent-working-memory/tier-b/topics" ] && [ -f "$FAKE_HOME/.claude/agent-working-memory/tier-a.md" ]; then
    record "AC-4" "PASS" "subtree + tier-a.md present"
  else
    record "AC-4" "FAIL" "subtree missing after install"
  fi
else
  record "AC-4" "FAIL" "installer exited non-zero"
fi

# ---- AC-5: hook standalone emits bounded tier-a ----
echo "[AC-5] SessionStart hook standalone"
HOOK_TMP="$(mktemp -d)"
mkdir -p "$HOOK_TMP/tier-b/topics/demo"
cat > "$HOOK_TMP/tier-b/topics/demo/ac5-card.md" <<'EOF'
---
id: ac5-card
topic: demo
title: ac5 fixture
created: 2026-04-10
pinned: true
tags: []
---

## Decision
ac5 fixture card
EOF
HOOK_OUT="$(WORKING_MEMORY_ROOT="$HOOK_TMP" HOME="$HOOK_TMP" bash "$REPO_ROOT/hooks/session-start.sh" 2>/dev/null || true)"
HOOK_BYTES=$(printf '%s' "$HOOK_OUT" | wc -c)
if [ "$HOOK_BYTES" -gt 0 ] && [ "$HOOK_BYTES" -le 5120 ]; then
  record "AC-5" "PASS" "hook bytes=$HOOK_BYTES (0<x<=5120)"
else
  record "AC-5" "FAIL" "hook bytes=$HOOK_BYTES out of bounds"
fi

# ---- AC-6: card-shape validator classifies 3+3 correctly ----
echo "[AC-6] card-shape 3 valid + 3 invalid"
AC6_OUT="$(node --test "$REPO_ROOT/tests/card-shape.test.mjs" 2>&1 || true)"
if printf '%s' "$AC6_OUT" | grep -q "# fail 0" && printf '%s' "$AC6_OUT" | grep -q "# pass 2"; then
  record "AC-6" "PASS" "card-shape.test.mjs all passed"
else
  record "AC-6" "FAIL" "card-shape.test.mjs did not all pass"
  printf '%s\n' "$AC6_OUT" | tail -20
fi

# ---- AC-7: compact deterministic + bounded + includes pinned ----
echo "[AC-7] compact algorithm"
AC7_OUT="$(node --test "$REPO_ROOT/tests/compact.test.mjs" 2>&1 || true)"
if printf '%s' "$AC7_OUT" | grep -q "# fail 0"; then
  record "AC-7" "PASS" "compact.test.mjs all passed"
else
  record "AC-7" "FAIL" "compact.test.mjs did not all pass"
  printf '%s\n' "$AC7_OUT" | tail -20
fi

# ---- AC-8: README has four required topic headings ----
echo "[AC-8] README heading grep"
MISSING=""
for topic in "Install" "First card" "cairn" "philosophy"; do
  if ! grep -qE "^#+ .*${topic}" "$REPO_ROOT/README.md"; then
    MISSING="$MISSING $topic"
  fi
done
if [ -z "$MISSING" ]; then
  record "AC-8" "PASS" "all four headings present"
else
  record "AC-8" "FAIL" "missing:$MISSING"
fi

# ---- AC-9: repo tree is hygiene-clean ----
echo "[AC-9] hygiene-only entry point"
if ( cd "$REPO_ROOT" && npm run hygiene ) >/tmp/ac9.log 2>&1; then
  record "AC-9" "PASS" "npm run hygiene exit 0"
else
  record "AC-9" "FAIL" "npm run hygiene non-zero"
  tail -20 /tmp/ac9.log || true
fi

# ---- AC-10: .gitignore blocks real-user-content paths ----
echo "[AC-10] .gitignore rules"
if grep -E "(^|/)tier-b/topics(/|$)" "$REPO_ROOT/.gitignore" >/dev/null || grep -E "\*\.card\.md" "$REPO_ROOT/.gitignore" >/dev/null; then
  record "AC-10" "PASS" ".gitignore matches"
else
  record "AC-10" "FAIL" ".gitignore has no matching rule"
fi

# ---- AC-1: GitHub repo visibility/license/tag (only if AC1=1) ----
if [ "${AC1:-0}" = "1" ]; then
  echo "[AC-1] GitHub repo visibility/license/tag"
  LOGIN="$(gh api user --jq .login 2>/dev/null || echo "")"
  if [ -z "$LOGIN" ]; then
    record "AC-1" "FAIL" "gh api user failed"
  else
    META="$(gh repo view "$LOGIN/agent-working-memory" --json visibility,licenseInfo,latestRelease 2>/dev/null || echo "")"
    VIS="$(printf '%s' "$META" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).visibility||"")}catch{console.log("")}})')"
    LIC="$(printf '%s' "$META" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log((JSON.parse(s).licenseInfo||{}).name||"")}catch{console.log("")}})')"
    TAG="$(printf '%s' "$META" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log((JSON.parse(s).latestRelease||{}).tagName||"")}catch{console.log("")}})')"
    if [ "$VIS" = "PUBLIC" ] && printf '%s' "$LIC" | grep -qi "MIT" && [ "$TAG" = "v0.1.0" ]; then
      record "AC-1" "PASS" "visibility=$VIS license=$LIC tag=$TAG"
    else
      record "AC-1" "FAIL" "visibility=$VIS license=$LIC tag=$TAG"
    fi
  fi
else
  record "AC-1" "SKIP" "AC1 env var not set; run with AC1=1 after push+tag"
fi

# ---- summary ----
line
printf 'P1 ACCEPTANCE SUMMARY\n'
line
printf '%-6s | %-4s | %s\n' "AC" "STAT" "DETAIL"
for r in "${RESULTS[@]}"; do printf '%s\n' "$r"; done
line
printf 'total PASS=%d FAIL=%d\n' "$PASS" "$FAIL"

if [ "$FAIL" -eq 0 ]; then
  # If AC-1 was skipped, that's acceptable for the pre-tag self-check but the
  # caller is responsible for running once more with AC1=1 after push+tag.
  for r in "${RESULTS[@]}"; do
    if echo "$r" | grep -q "| SKIP |"; then
      echo "NOTE: one or more ACs SKIPPED (see rows above)"
    fi
  done
  exit 0
fi
exit 1

# ship-fix #1: privacy-token leak in plan file + PR body

## ELI5

Stage 5 self-review caught that the plan file we just committed embeds the
regulated employer-brand token literally — same problem the test file had,
just in a different place. Plan files end up on master and become public,
and the rule-spec exemption only covers two specific cards.

Rewrite the plan + PR body to use placeholder vocabulary (`<bare-token>`,
`<spaced-bare-token>`, `<award-name>`) like Stage 5.6's self-test pattern.

## Binary AC

- **AC-1**: `git grep -nE 'UOB|U\.O\.B|Best Foreign Bank' .ai-workspace/plans/`
  returns zero hits AFTER the edit.
- **AC-2**: `gh pr view 28 --json body | grep -E 'UOB|U\.O\.B|Best Foreign Bank'`
  returns zero hits AFTER the body edit.
- **AC-3**: Plan file remains semantically correct (grep verifier strings
  are still self-describing — `<bare-token>` is unambiguous).

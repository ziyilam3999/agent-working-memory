// PM2 ecosystem owned by agent-working-memory.
//
// One app — `working-memory-content-sync` — runs scripts/content-sync.mjs on
// a daily cron to keep pinned tier-b cards in lockstep with the GitHub backup
// repo `agent-working-memory-content`.
//
// Coexistence: this file is INTENTIONALLY separate from ai-brain's
// ecosystem.config.cjs. The `working-memory-` prefix on the app name keeps
// the two PM2 namespaces from colliding on the host's daemon. See plan
// `.ai-workspace/plans/2026-04-25-memory-status-pass.md` Goal §6 + B6
// "Coexistence" clause.
//
// Bootstrap order: ai-brain's PM2 entries (Cairn H4-H7 + housekeep) should
// start before this one so the H7 cron has fired at least once and the
// status fragment at $HOME/.claude/cairn/status-fragment.md exists before
// any session consumer reads it. agent-working-memory's sync runner does
// NOT consume the fragment — only the SessionStart-hook tier-a refresh
// does — so the order is best-practice rather than a hard dependency.
//
// Activation:
//   pm2 start ecosystem.config.cjs   # one-shot; pm2 keeps the schedule
//   pm2 save                         # persist across reboots
//
// Disable:
//   pm2 stop working-memory-content-sync
//   pm2 delete working-memory-content-sync

const path = require("node:path");
const REPO = __dirname;

module.exports = {
  apps: [
    {
      // Globally unique name across all ecosystem files registered against
      // the host's PM2 daemon. The "working-memory-" prefix gives namespace
      // separation from ai-brain's "cairn-h4/h5/h6/h7" + "housekeep" apps.
      name: "working-memory-content-sync",
      script: "scripts/content-sync.mjs",
      interpreter: "node",
      // Daily at 04:30 local — staggered after ai-brain's H5 (03:00) and
      // H6 (Mon 04:00) so the cron storms don't pile up on the same minute.
      cron_restart: "30 4 * * *",
      autorestart: false,
      watch: false,
      cwd: REPO,
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
      },
      out_file: path.join(REPO, ".pm2", "content-sync.out.log"),
      error_file: path.join(REPO, ".pm2", "content-sync.err.log"),
      kill_timeout: 600000,
    },
  ],
};

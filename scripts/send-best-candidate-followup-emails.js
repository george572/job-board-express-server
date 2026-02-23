#!/usr/bin/env node
/**
 * Get sent emails from the last 7 days (new_job_email_sent), find the jobs they
 * were sent for, run AI vector search + Gemini assessment to find 1 good/strong
 * match per job, then queue "best candidate" follow-up emails spread over 5–6 hours.
 *
 * Usage: node scripts/send-best-candidate-followup-emails.js [--dry-run]
 *   --dry-run: log what would be queued, do not insert into queue
 *
 * Requires: .env with PINECONE_API_KEY, JINA_API_KEY (or embedding env), GEMINI_API_KEY,
 *           MARKETING_MAIL_USER / MARKETING_MAIL_PASS (for queue processor to send later).
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);
const {
  runBulkBestCandidateFollowupFromLast7Days,
  SPREAD_HOURS,
} = require("../services/bulkBestCandidateFollowup");

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const result = await runBulkBestCandidateFollowupFromLast7Days(db, { dryRun });

  console.log(
    `\n[send-best-candidate-followup] Sent emails (last 7 days): ${result.sentRowsCount} → ${result.companyCount} companies → ${result.jobCount} job(s)\n`
  );
  if (result.companyCount === 0) {
    console.log("No sent emails in the last 7 days. Nothing to do.\n");
    await db.destroy();
    process.exit(0);
  }
  if (result.jobCount === 0) {
    console.log("No matching jobs found for those companies. Nothing to queue.\n");
    await db.destroy();
    process.exit(0);
  }

  if (dryRun) {
    console.log("  (DRY RUN – no queue inserts)\n");
    console.log(
      `Would queue ${result.wouldInsert ?? result.queued} best-candidate follow-up(s) over ${result.spreadHours ?? SPREAD_HOURS}h.\n`
    );
    await db.destroy();
    process.exit(0);
  }

  if (result.queued > 0 && result.skipped > 0) {
    console.log(`  Skipped ${result.skipped} job(s): no good/strong candidate.\n`);
  }
  if (result.alreadyInQueue > 0) {
    console.log(
      `  (${result.alreadyInQueue} job(s) already in queue for best_candidate_followup – skipped)\n`
    );
  }

  if (result.inserted === 0) {
    console.log("\nNothing new to queue (all already in queue or no candidates).\n");
    await db.destroy();
    process.exit(0);
  }

  console.log(
    `Queued ${result.inserted} best-candidate follow-up(s). First send in 10 min; spread over ${result.spreadHours ?? SPREAD_HOURS}h.\n`
  );
  console.log(
    `Check /jobs/email-queue-details (or your admin queue view) to see them. Each item includes candidate cv_url or phone/email.\n`
  );
  await db.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

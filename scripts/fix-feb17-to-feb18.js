/**
 * One-time script: Add 4 hours to created_at of first 45 jobs dated Feb 17 (UTC)
 * so they display as Feb 18 in Georgia time.
 *
 * Usage: node scripts/fix-feb17-to-feb18.js [--apply]
 *   Without --apply: dry run, shows what would be updated
 *   With --apply: performs the update
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);

const LIMIT = 25;
const TARGET_DATE = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || "2026-02-17";
const HOURS_TO_ADD = 15; // 05:45 UTC → 20:45 UTC = 00:45 Feb 18 Georgia

async function main() {
  const doApply = process.argv.includes("--apply");

  const jobs = await db("jobs")
    .select("id", "jobName", "created_at")
    .whereRaw("created_at::date = ?", [TARGET_DATE])
    .orderBy("created_at", "desc")
    .limit(LIMIT);

  if (jobs.length === 0) {
    console.log(`No jobs found with created_at::date = ${TARGET_DATE}`);
    await db.destroy();
    return;
  }

  console.log(`\nFound ${jobs.length} jobs dated ${TARGET_DATE} (${LIMIT} most recent by created_at)`);
  jobs.forEach((j, i) => {
    const oldDate = new Date(j.created_at);
    const newDate = new Date(oldDate.getTime() + HOURS_TO_ADD * 60 * 60 * 1000);
    console.log(`  ${i + 1}. #${j.id} ${j.jobName} — ${oldDate.toISOString()} → ${newDate.toISOString()}`);
  });

  if (!doApply) {
    console.log("\nDry run. Run with --apply to update.");
    await db.destroy();
    return;
  }

  const ids = jobs.map((j) => j.id);
  const updated = await db("jobs")
    .whereIn("id", ids)
    .update({
      created_at: db.raw(`created_at + interval '${HOURS_TO_ADD} hours'`),
    });

  console.log(`\nUpdated ${updated} jobs. created_at += ${HOURS_TO_ADD} hours`);
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

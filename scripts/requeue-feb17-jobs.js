/**
 * One-time script: Queue new-job emails for jobs created on Feb 17
 * - Excludes 512, 513, 514, 515, 516 (already sent)
 * - Excludes the last job (most recently created)
 *
 * Usage: node scripts/requeue-feb17-jobs.js [--send]
 *   Without --send: dry run, shows what would be queued
 *   With --send: POSTs to server to add to queue (server must be running)
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);

const EXCLUDED_IDS = [512, 513, 514, 515, 516];
const TARGET_DATE = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || "2026-02-17";
const SERVER_URL = process.env.SITE_BASE_URL || "http://localhost:4000";

async function main() {
  const doSend = process.argv.includes("--send");

  const jobs = await db("jobs")
    .select("id", "jobName", "companyName", "company_email", "created_at")
    .where("job_status", "approved")
    .whereRaw("created_at::date = ?", [TARGET_DATE])
    .whereNotIn("id", EXCLUDED_IDS)
    .whereRaw("(dont_send_email IS NOT TRUE)")
    .whereNotNull("company_email")
    .whereRaw("trim(company_email) != ''")
    .orderBy("id", "asc");

  if (jobs.length === 0) {
    console.log(`No jobs found for ${TARGET_DATE} (excluding ${EXCLUDED_IDS.join(", ")})`);
    await db.destroy();
    return;
  }

  // Exclude last one
  const toQueue = jobs.slice(0, -1);
  const excludedLast = jobs[jobs.length - 1];

  console.log(`\n=== ${TARGET_DATE} jobs ===`);
  console.log(`Total found (excl. ${EXCLUDED_IDS.join(", ")}): ${jobs.length}`);
  console.log(`Excluding last: #${excludedLast.id} ${excludedLast.jobName} (${excludedLast.companyName})`);
  console.log(`To queue: ${toQueue.length} jobs\n`);

  toQueue.forEach((j, i) => {
    console.log(`  ${i + 1}. #${j.id} ${j.jobName} — ${j.companyName} (${j.company_email})`);
  });

  if (!doSend) {
    console.log("\nDry run. Run with --send to add to server queue (server must be running).");
    await db.destroy();
    return;
  }

  const jobIds = toQueue.map((j) => j.id);
  const url = `${SERVER_URL}/jobs/requeue-new-job-emails`;
  console.log(`\nPOSTing ${jobIds.length} job IDs to ${url}...`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    console.log(`Done. Added: ${data.added}, Queue pending: ${data.pending}`);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }

  await db.destroy();
}

main();

#!/usr/bin/env node
/**
 * Find approved jobs that have company_email and are NOT in the new_job email queue,
 * then requeue them (evaluate + add to queue). One email per job.
 *
 * Usage:
 *   node scripts/requeue-jobs-not-in-email-queue.js              # all such jobs
 *   node scripts/requeue-jobs-not-in-email-queue.js 77          # only 77 most recent by id
 *   node scripts/requeue-jobs-not-in-email-queue.js --dry-run    # print IDs and count, do not requeue
 *   node scripts/requeue-jobs-not-in-email-queue.js --ids 1067,1063,1061  # requeue these IDs only
 *   node scripts/requeue-jobs-not-in-email-queue.js --ids-file scripts/requeue-ids.txt
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = require("knex")(knexConfig[env]);

async function main() {
  const rawArgs = process.argv.slice(2);
  const dryRun = rawArgs.includes("--dry-run");
  const idsArgIdx = rawArgs.indexOf("--ids");
  const idsFileIdx = rawArgs.indexOf("--ids-file");
  let jobIdsFromArgs = null;
  if (idsArgIdx >= 0 && rawArgs[idsArgIdx + 1]) {
    jobIdsFromArgs = rawArgs[idsArgIdx + 1]
      .split(/[\s,]+/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);
  }
  if (idsFileIdx >= 0 && rawArgs[idsFileIdx + 1]) {
    const filePath = path.resolve(process.cwd(), rawArgs[idsFileIdx + 1]);
    const content = fs.readFileSync(filePath, "utf8");
    jobIdsFromArgs = content
      .split(/[\s,\n]+/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);
  }

  const args = rawArgs.filter(
    (a) =>
      a !== "--dry-run" &&
      a !== "--ids" &&
      a !== "--ids-file" &&
      (idsArgIdx < 0 || a !== rawArgs[idsArgIdx + 1]) &&
      (idsFileIdx < 0 || a !== rawArgs[idsFileIdx + 1]),
  );
  const limit = args.length > 0 ? parseInt(args[0], 10) : null;

  let jobIds;

  if (jobIdsFromArgs && jobIdsFromArgs.length > 0) {
    jobIds = jobIdsFromArgs;
    console.log(`\nUsing ${jobIds.length} job IDs from --ids / --ids-file.\n`);
  } else {
    const jobsQuery = db("jobs")
      .select("id", "jobName", "companyName", "company_email")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .whereNotNull("company_email")
      .whereRaw("TRIM(company_email) != ''")
      .where((qb) =>
        qb.where("dont_send_email", false).orWhereNull("dont_send_email"),
      )
      .orderBy("id", "desc");

    if (limit != null && limit > 0) {
      jobsQuery.limit(limit);
    }

    const jobs = await jobsQuery;

    const queuedJobIds = await db("new_job_email_queue")
      .where((qb) => qb.where("email_type", "new_job").orWhereNull("email_type"))
      .select("job_id")
      .then((rows) => new Set(rows.map((r) => r.job_id)));

    const notInQueue = jobs.filter((j) => !queuedJobIds.has(j.id));
    jobIds = notInQueue.map((j) => j.id);

    console.log(
      `\nJobs with email, not in queue: ${jobIds.length} (of ${jobs.length} considered)\n`,
    );
  }

  if (jobIds.length === 0) {
    console.log("Nothing to requeue.");
    await db.destroy();
    process.exit(0);
  }

  console.log("Job IDs to requeue:", jobIds.join(", "));
  console.log("");

  if (dryRun) {
    console.log("--dry-run: not calling requeue. Run without --dry-run to requeue.");
    await db.destroy();
    process.exit(0);
  }

  const jobsRouter = require("../routes/jobs")(db);
  const result = await jobsRouter.requeueJobsByIds(jobIds);

  console.log(`Requeued: ${result.added} added to queue, ${result.pending} pending in queue now.\n`);
  await db.destroy();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

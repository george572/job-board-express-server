#!/usr/bin/env node
/**
 * Assign all jobs with HR-related titles/descriptions to the HR category.
 * Usage:
 *   node scripts/assign-hr-jobs.js          # Dry run (preview only)
 *   node scripts/assign-hr-jobs.js --apply # Apply changes to DB
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const knex = require("knex")(require("../knexfile")[process.env.NODE_ENV || "development"]);

const HR_CATEGORY_ID = 26;
const APPLY = process.argv.some((a) => a === "--apply" || a === "-a");

// Only check JOB TITLE - descriptions have boilerplate (ადამიანური რესურსების პოლიტიკა etc)
const HR_KEYWORDS = ["human resource", "ადამიანური რესურსები", "რეკრუტერი"];

function isHrJob(job) {
  const title = (job.jobName || "").toLowerCase();
  if (/\bhr\b/i.test(job.jobName || "")) return true;
  return HR_KEYWORDS.some((kw) => title.includes(kw.toLowerCase()));
}

async function main() {
  const hrCat = await knex("categories").where("id", HR_CATEGORY_ID).first();
  if (!hrCat) {
    console.error("HR category (id 26) not found. Run migrations first: npx knex migrate:latest");
    process.exit(1);
  }

  const jobs = await knex("jobs")
    .select("id", "jobName", "jobDescription", "companyName", "category_id")
    .where("job_status", "approved")
    .orderBy("id");

  const hrJobs = jobs.filter(isHrJob);

  console.log(APPLY ? "*** APPLY MODE – changes will be saved ***\n" : "*** DRY RUN – use --apply to save ***\n");
  console.log(`Found ${hrJobs.length} HR jobs out of ${jobs.length} total\n`);

  if (hrJobs.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  let updated = 0;
  for (const job of hrJobs) {
    if (job.category_id === HR_CATEGORY_ID) {
      console.log(`#${job.id} "${(job.jobName || "").slice(0, 50)}" – already HR`);
      continue;
    }
    if (APPLY) {
      const n = await knex("jobs").where("id", job.id).update({ category_id: HR_CATEGORY_ID, updated_at: knex.fn.now() });
      if (n > 0) updated++;
      console.log(`#${job.id} "${(job.jobName || "").slice(0, 50)}" → HR`);
    } else {
      console.log(`#${job.id} "${(job.jobName || "").slice(0, 50)}" → would assign to HR`);
      updated++;
    }
  }

  console.log(`\nDone. ${APPLY ? "Updated" : "Would update"}: ${updated}`);
  if (!APPLY && updated > 0) {
    console.log("\nRun with --apply to apply changes.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

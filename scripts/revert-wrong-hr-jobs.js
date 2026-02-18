#!/usr/bin/env node
/**
 * Revert jobs wrongly placed in HR back to სხვა (19).
 * Only keeps jobs that match: HR (word), human resource(s), ადამიანური რესურსები, რეკრუტერი.
 * Usage:
 *   node scripts/revert-wrong-hr-jobs.js          # Dry run
 *   node scripts/revert-wrong-hr-jobs.js --apply # Apply
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const knex = require("knex")(require("../knexfile")[process.env.NODE_ENV || "development"]);

const HR_CATEGORY_ID = 26;
const OTHER_CATEGORY_ID = 19; // სხვა
const APPLY = process.argv.some((a) => a === "--apply" || a === "-a");

// Only check JOB TITLE - descriptions have boilerplate like "ადამიანური რესურსების პოლიტიკა"
const HR_KEYWORDS = ["human resource", "ადამიანური რესურსები", "რეკრუტერი"];

function isReallyHrJob(job) {
  const title = ((job.jobName || "")).toLowerCase();
  if (/\bhr\b/i.test(job.jobName || "")) return true;
  return HR_KEYWORDS.some((kw) => title.includes(kw.toLowerCase()));
}

async function main() {
  const jobs = await knex("jobs")
    .select("id", "jobName", "jobDescription", "companyName", "category_id")
    .where("category_id", HR_CATEGORY_ID)
    .where("job_status", "approved")
    .orderBy("id");

  const toRevert = jobs.filter((j) => !isReallyHrJob(j));

  console.log(APPLY ? "*** APPLY – reverting wrong HR jobs to სხვა ***\n" : "*** DRY RUN – use --apply to save ***\n");
  console.log(`HR category has ${jobs.length} jobs. ${toRevert.length} will be reverted (don't match HR/human resource/ადამიანური რესურსები/რეკრუტერი).\n`);

  if (toRevert.length === 0) {
    console.log("Nothing to revert.");
    process.exit(0);
  }

  for (const job of toRevert) {
    if (APPLY) {
      await knex("jobs").where("id", job.id).update({ category_id: OTHER_CATEGORY_ID, updated_at: knex.fn.now() });
    }
    console.log(`#${job.id} "${(job.jobName || "").slice(0, 50)}" → სხვა (19)${APPLY ? "" : " [would revert]"}`);
  }

  console.log(`\nDone. ${APPLY ? "Reverted" : "Would revert"}: ${toRevert.length}`);
  if (!APPLY) console.log("\nRun with --apply to apply.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Find jobs for legal professions (lawyers, attorneys, notaries, etc.)
 * and assign them to the იურიდიული (Legal) category.
 *
 * Only matches on JOB TITLE (jobName) – profession names only, to avoid
 * false positives from descriptions mentioning "legal", "იურიდიული პირი", etc.
 *
 * Usage:
 *   node scripts/assign-legal-jobs.js          # Dry run (preview only)
 *   node scripts/assign-legal-jobs.js --apply  # Apply changes to DB
 *   node scripts/assign-legal-jobs.js --revert # Move wrongly assigned jobs back to სხვა (19)
 *
 * Run migrations first: npx knex migrate:latest
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const knex = require("knex")(require("../knexfile")[process.env.NODE_ENV || "development"]);

const LEGAL_CATEGORY_ID = 27;
const OTHER_CATEGORY_ID = 19; // სხვა
const APPLY = process.argv.some((a) => a === "--apply" || a === "-a");
const REVERT = process.argv.some((a) => a === "--revert" || a === "-r");

// Profession names only – in job TITLE. No generic terms like "legal", "იურიდიული".
const LEGAL_TITLE_KEYWORDS = [
  "იურისტი",
  "ადვოკატი",
  "ნოტარიუსი",
  "ნოტარი",
  "lawyer",
  "attorney",
  "notary",
  "юрист",
  "адвокат",
  "нотариус",
];

function isLegalJob(job) {
  const title = (job.jobName || "").toLowerCase();
  return LEGAL_TITLE_KEYWORDS.some((kw) => title.includes(kw.toLowerCase()));
}

async function main() {
  const legalCat = await knex("categories").where("id", LEGAL_CATEGORY_ID).first();
  if (!legalCat) {
    console.error("იურიდიული category (id 27) not found. Run migrations first: npx knex migrate:latest");
    process.exit(1);
  }

  const jobs = await knex("jobs")
    .select("id", "jobName", "companyName", "category_id")
    .where("job_status", "approved")
    .orderBy("id");

  if (REVERT) {
    const wronglyAssigned = jobs.filter((j) => j.category_id === LEGAL_CATEGORY_ID && !isLegalJob(j));
    console.log(APPLY ? "*** REVERT – moving wrong jobs back to სხვა ***\n" : "*** DRY RUN – use --revert --apply to save ***\n");
    console.log(`Found ${wronglyAssigned.length} wrongly assigned jobs to revert\n`);

    if (wronglyAssigned.length === 0) {
      console.log("Nothing to revert.");
      process.exit(0);
    }

    let reverted = 0;
    for (const job of wronglyAssigned) {
      if (APPLY) {
        const n = await knex("jobs")
          .where("id", job.id)
          .update({ category_id: OTHER_CATEGORY_ID, updated_at: knex.fn.now() });
        if (n > 0) reverted++;
        console.log(`#${job.id} "${(job.jobName || "").slice(0, 50)}" → სხვა`);
      } else {
        console.log(`#${job.id} "${(job.jobName || "").slice(0, 50)}" → would revert to სხვა`);
        reverted++;
      }
    }
    console.log(`\nDone. ${APPLY ? "Reverted" : "Would revert"}: ${reverted}`);
    if (!APPLY && reverted > 0) console.log("\nRun with --revert --apply to apply.");
    process.exit(0);
  }

  const legalJobs = jobs.filter(isLegalJob);
  console.log(APPLY ? "*** APPLY MODE – changes will be saved ***\n" : "*** DRY RUN – use --apply to save ***\n");
  console.log(`Found ${legalJobs.length} legal profession jobs (title match) out of ${jobs.length} total\n`);

  if (legalJobs.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  let updated = 0;
  for (const job of legalJobs) {
    if (job.category_id === LEGAL_CATEGORY_ID) {
      console.log(`#${job.id} "${(job.jobName || "").slice(0, 50)}" – already იურიდიული`);
      continue;
    }
    if (APPLY) {
      const n = await knex("jobs")
        .where("id", job.id)
        .update({ category_id: LEGAL_CATEGORY_ID, updated_at: knex.fn.now() });
      if (n > 0) updated++;
      console.log(`#${job.id} "${(job.jobName || "").slice(0, 50)}" → იურიდიული`);
    } else {
      console.log(`#${job.id} "${(job.jobName || "").slice(0, 50)}" → would assign to იურიდიული`);
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

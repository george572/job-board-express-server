#!/usr/bin/env node
/**
 * Re-categorize jobs in "სხვა" (other, category_id=19) using Gemini AI.
 * Usage:
 *   node scripts/recategorize-other-jobs.js          # Dry run (preview only)
 *   node scripts/recategorize-other-jobs.js --apply  # Apply changes to DB
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const knex = require("knex")(require("../knexfile")[process.env.NODE_ENV || "development"]);
const { GoogleGenerativeAI } = require("@google/generative-ai");

const OTHER_CATEGORY_ID = 19; // სხვა
const RECOMMENDED_CATEGORY_ID = 9999;
const KEYWORD_RULES = [
  { keyword: "მძღოლი", categoryName: "მძღოლი" },
  { keyword: "ადამიანური რესურსები", categoryName: "HR" },
  { keyword: "human resource", categoryName: "HR" },
  { keyword: "რეკრუტერი", categoryName: "HR" },
];
const APPLY = process.argv.some((a) => a === "--apply" || a === "-a");
const BATCH_DELAY_MS = 5000; // Rate limit Gemini (5 seconds)

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_CV_READER_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY or GEMINI_CV_READER_API_KEY required in .env");
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

  const categories = await knex("categories")
    .select("id", "name")
    .whereNot("id", RECOMMENDED_CATEGORY_ID)
    .orderBy("id");
  const categoryList = categories.map((c) => `${c.id}: ${c.name}`).join("\n");
  const validIds = new Set(categories.map((c) => String(c.id)));

  const jobs = await knex("jobs")
    .select("id", "jobName", "jobDescription", "companyName", "job_city")
    .where("category_id", OTHER_CATEGORY_ID)
    .where("job_status", "approved")
    .orderBy("id");

  console.log(APPLY ? "*** APPLY MODE – changes will be saved to DB ***\n" : "*** DRY RUN – use --apply to save changes ***\n");
  console.log(`Found ${jobs.length} jobs in category "სხვა" (id=19)\n`);
  if (jobs.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  const categoryNames = Object.fromEntries(categories.map((c) => [String(c.id), c.name]));
  const categoryByName = Object.fromEntries(categories.map((c) => [c.name, c.id]));

  function getKeywordMatch(job) {
    const title = (job.jobName || "").toLowerCase();
    if (/\bhr\b/i.test(job.jobName || "")) {
      const catId = categoryByName["HR"];
      if (catId) return String(catId);
    }
    for (const { keyword, categoryName } of KEYWORD_RULES) {
      if (categoryName === "HR" && title.includes(keyword.toLowerCase())) {
        const catId = categoryByName[categoryName];
        if (catId) return String(catId);
      }
    }
    for (const { keyword, categoryName } of KEYWORD_RULES) {
      if (categoryName !== "HR") {
        const text = ((job.jobName || "") + " " + (job.jobDescription || "")).toLowerCase();
        if (text.includes(keyword.toLowerCase())) {
          const catId = categoryByName[categoryName];
          if (catId) return String(catId);
        }
      }
    }
    return null;
  }

  const promptTemplate = (job) => `You are a job classifier. Assign the BEST category for this job. Reply with ONLY the category ID number, nothing else.

Available categories:
${categoryList}

Job title: ${(job.jobName || "").trim()}
Company: ${(job.companyName || "").trim()}
Location: ${(job.job_city || "").trim()}
Description: ${(job.jobDescription || "").substring(0, 800).trim()}

Reply with only the number (e.g. 21):`;

  let updated = 0;
  let kept = 0;
  let errors = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    let usedKeyword = false;
    try {
      let suggestedId = getKeywordMatch(job);
      usedKeyword = !!suggestedId;
      if (!suggestedId) {
        const result = await model.generateContent(promptTemplate(job));
        const resp = (result.response?.text() || "").trim();
        const m = resp.match(/\b(\d+)\b/);
        suggestedId = m && validIds.has(m[1]) ? m[1] : null;
      }

      if (!suggestedId || !validIds.has(suggestedId)) {
        console.log(`[${i + 1}/${jobs.length}] #${job.id} "${(job.jobName || "").slice(0, 40)}" → invalid/unmatched (keeping 19)`);
        kept++;
      } else {
        const catName = categoryNames[suggestedId];
        if (APPLY) {
          const n = await knex("jobs").where("id", job.id).update({ category_id: parseInt(suggestedId, 10), updated_at: knex.fn.now() });
          if (n === 0) console.error(`  WARNING: no rows updated for job #${job.id}`);
          console.log(`[${i + 1}/${jobs.length}] #${job.id} "${(job.jobName || "").slice(0, 40)}" → ${suggestedId} (${catName})${usedKeyword ? " [keyword]" : ""}`);
          updated++;
        } else {
          console.log(`[${i + 1}/${jobs.length}] #${job.id} "${(job.jobName || "").slice(0, 40)}" → would change to ${suggestedId} (${catName})${usedKeyword ? " [keyword]" : ""}`);
          updated++;
        }
      }
    } catch (err) {
      console.error(`[${i + 1}/${jobs.length}] #${job.id} error:`, err.message);
      errors++;
    }
    if (!usedKeyword) await delay(BATCH_DELAY_MS);
  }

  console.log(`\nDone. ${APPLY ? "Updated" : "Would update"}: ${updated}, kept in სხვა: ${kept}, errors: ${errors}`);
  if (!APPLY && updated > 0) {
    console.log("\nRun with --apply to apply changes.");
  }
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

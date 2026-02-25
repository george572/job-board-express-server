#!/usr/bin/env node
/**
 * Classify all approved jobs as ადგილზე (onsite) or დისტანციური (remote) using Gemini AI.
 *
 * Usage:
 *   node scripts/classify-work-mode.js              # Dry run (preview only)
 *   node scripts/classify-work-mode.js --apply      # Apply changes to DB
 *   node scripts/classify-work-mode.js --limit 10   # Process only 10 jobs (for testing)
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const knex = require("knex")(require("../knexfile")[process.env.NODE_ENV || "development"]);
const { GoogleGenerativeAI } = require("@google/generative-ai");

const APPLY = process.argv.some((a) => a === "--apply" || a === "-a");
const LIMIT = process.argv.includes("--limit")
  ? parseInt(process.argv[process.argv.indexOf("--limit") + 1], 10) || 10
  : null;
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 2000;

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

  let query = knex("jobs")
    .select("id", "jobName", "jobDescription", "companyName", "job_city", "job_address")
    .where("job_status", "approved")
    .orderBy("id");

  if (LIMIT) query = query.limit(LIMIT);
  const jobs = await query;

  console.log(APPLY ? "*** APPLY MODE – changes will be saved to DB ***\n" : "*** DRY RUN – use --apply to save changes ***\n");
  console.log(`Found ${jobs.length} approved jobs to classify\n`);

  if (jobs.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  const PROMPT_TEMPLATE = (batch) => `You are a strict job classifier. For each job below, determine if it is TRULY remote (დისტანციური) or onsite (ადგილზე).

A job is დისტანციური ONLY if the description or title contains an EXPLICIT phrase like:
- "დისტანციური" or "დისტანციურად" (the Georgian word for remote)
- "სახლიდან მუშაობა" (work from home)
- "remote" or "work from home" or "fully remote" (English)

DO NOT classify as remote if:
- The job just mentions "ონლაინ" in its title (like ონლაინ გაყიდვები, ონლაინ მხარდაჭერა) — this means online sales/support, NOT remote work
- The job has a physical city/location without mentioning remote
- The job mentions flexible schedule (მოქნილი გრაფიკი) — this does NOT mean remote
- It is a social media manager, content creator, sales manager — these are usually onsite unless they explicitly say remote/დისტანციური

When in doubt, classify as ადგილზე.

Reply with ONLY a JSON array of objects, each with "id" (number) and "mode" (either "ადგილზე" or "დისტანციური"). No extra text.

Jobs:
${batch.map((j) => `ID: ${j.id}\nTitle: ${(j.jobName || "").trim()}\nCompany: ${(j.companyName || "").trim()}\nCity: ${(j.job_city || "").trim()}\nAddress: ${(j.job_address || "").trim()}\nDescription: ${(j.jobDescription || "").replace(/<[^>]*>/g, " ").substring(0, 600).trim()}\n---`).join("\n")}

Reply with ONLY the JSON array:`;

  let remoteCount = 0;
  let onsiteCount = 0;
  let errors = 0;

  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(jobs.length / BATCH_SIZE);

    try {
      const result = await model.generateContent(PROMPT_TEMPLATE(batch));
      let resp = (result.response?.text() || "").trim();
      resp = resp.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

      let classifications;
      try {
        classifications = JSON.parse(resp);
      } catch {
        console.error(`[Batch ${batchNum}/${totalBatches}] Failed to parse Gemini response: ${resp.substring(0, 200)}`);
        errors += batch.length;
        await delay(BATCH_DELAY_MS);
        continue;
      }

      const classMap = new Map(classifications.map((c) => [c.id, c.mode]));

      for (const job of batch) {
        const mode = classMap.get(job.id);
        if (!mode || (mode !== "ადგილზე" && mode !== "დისტანციური")) {
          console.log(`  #${job.id} "${(job.jobName || "").slice(0, 40)}" → invalid response, defaulting to ადგილზე`);
          if (APPLY) {
            await knex("jobs").where("id", job.id).update({ work_mode: "ადგილზე", updated_at: knex.fn.now() });
          }
          onsiteCount++;
          continue;
        }

        if (mode === "დისტანციური") {
          remoteCount++;
        } else {
          onsiteCount++;
        }

        const label = mode === "დისტანციური" ? "🏠 დისტანციური" : "🏢 ადგილზე";
        console.log(`  #${job.id} "${(job.jobName || "").slice(0, 40)}" → ${label}`);

        if (APPLY) {
          await knex("jobs").where("id", job.id).update({ work_mode: mode, updated_at: knex.fn.now() });
        }
      }

      console.log(`[Batch ${batchNum}/${totalBatches}] Done (${batch.length} jobs)\n`);
    } catch (err) {
      console.error(`[Batch ${batchNum}/${totalBatches}] Error:`, err.message);
      errors += batch.length;
    }

    if (i + BATCH_SIZE < jobs.length) await delay(BATCH_DELAY_MS);
  }

  console.log(`\n=== Summary ===`);
  console.log(`${APPLY ? "Updated" : "Would update"}: ${remoteCount + onsiteCount} jobs`);
  console.log(`  დისტანციური (remote): ${remoteCount}`);
  console.log(`  ადგილზე (onsite): ${onsiteCount}`);
  console.log(`  Errors: ${errors}`);

  if (!APPLY && (remoteCount + onsiteCount) > 0) {
    console.log("\nRun with --apply to save changes to the database.");
  }

  await knex.destroy();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

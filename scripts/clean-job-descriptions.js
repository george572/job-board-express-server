#!/usr/bin/env node
/**
 * Clean job descriptions using Gemini AI.
 *
 * Usage:
 *   node scripts/clean-job-descriptions.js              # Dry run (preview only)
 *   node scripts/clean-job-descriptions.js --apply      # Actually update DB
 *   node scripts/clean-job-descriptions.js --limit 5    # Process only 5 jobs (for testing)
 *
 * Requires GEMINI_API_KEY in .env
 */

require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const knex = require("knex");
const knexfile = require("../knexfile");

const environment = process.env.NODE_ENV || "development";
const db = knex(knexfile[environment]);

const APPLY = process.argv.includes("--apply");
const LIMIT = process.argv.includes("--limit")
  ? parseInt(process.argv[process.argv.indexOf("--limit") + 1], 10) || 5
  : null;

const BATCH_DELAY_MS = 1000; // 1 second between API calls to respect rate limits

const CLEAN_PROMPT = `You are cleaning a job posting description. The text is in Georgian.

TASKS:
- Remove promotional boilerplate (e.g. "Apply now!", "Send your CV to...", "We look forward to hearing from you")
- Remove excessive marketing language and keyword stuffing
- Remove redundant contact info if the same details appear elsewhere
- Simplify repetitive phrases
- Keep structure: responsibilities, requirements, qualifications, salary/benefits, location
- Output valid HTML: use <p>, <ul>, <li>, <br> for formatting. No inline styles.
- Keep the Georgian language and professional tone

Return ONLY the cleaned HTML. No explanation, no markdown code blocks, no extra text.`;

async function cleanWithGemini(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing in .env");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const prompt = CLEAN_PROMPT + "\n\n---\n\n" + text;
  const result = await model.generateContent(prompt);
  const response = result.response;
  if (!response || !response.text) {
    throw new Error("Empty response from Gemini");
  }
  return response.text().trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(APPLY ? "*** APPLY MODE: will update database ***" : "*** DRY RUN: no changes will be made ***");
  if (LIMIT) console.log(`Limit: ${LIMIT} jobs`);

  const query = db("jobs")
    .select("id", "jobName", "companyName", "jobDescription", "jobDescriptionOriginal")
    .where("job_status", "approved");
  const jobs = LIMIT ? await query.limit(LIMIT) : await query;

  console.log(`Found ${jobs.length} jobs to process.\n`);

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const desc = job.jobDescription || "";
    if (!desc.trim()) {
      console.log(`[${i + 1}/${jobs.length}] Skipped job ${job.id} (empty description)`);
      continue;
    }

    try {
      const cleaned = await cleanWithGemini(desc);
      if (!cleaned) {
        console.log(`[${i + 1}/${jobs.length}] Job ${job.id}: Gemini returned empty, skipping`);
        failed++;
        continue;
      }

      if (APPLY) {
        const hasOriginal = job.jobDescriptionOriginal != null && job.jobDescriptionOriginal !== "";
        const updates = { jobDescription: cleaned };
        if (!hasOriginal) updates.jobDescriptionOriginal = desc;
        await db("jobs").where("id", job.id).update(updates);
        updated++;
      }

      console.log(`[${i + 1}/${jobs.length}] Job ${job.id} (${job.jobName}): OK`);
    } catch (err) {
      console.error(`[${i + 1}/${jobs.length}] Job ${job.id}: ERROR -`, err.message);
      failed++;
    }

    if (i < jobs.length - 1) await delay(BATCH_DELAY_MS);
  }

  console.log(`\nDone. Updated: ${updated}, Failed: ${failed}`);
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

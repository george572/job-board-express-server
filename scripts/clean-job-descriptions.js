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
const fs = require("fs");
const path = require("path");
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

STRICTLY REMOVE (must not appear in output):
- Job type (სრული განაკვეთი, ნახევარი განაკვეთი, full-time, part-time, etc.)
- Job location, city, address
- Job position/title name
- Salary, ანაზღაურება, ₾, GEL, any payment info
- Contact info: phone, email, fax
- "გამოგზავნეთ CV", "Apply now", "Send your CV", "დაგვიკავშირდით"
- Personal traits: reliable, punctual, team player, etc.
- Marketing fluff, keyword stuffing

KEEP: Job responsibilities, requirements, qualifications, duties (ინდივიდუალური სამუშაოს აღწერა). Use <p>, <ul>, <li>, <br> only. No inline styles.

CRITICAL: Output RAW HTML only. NO markdown. NO \`\`\`html or \`\`\` around the output. NO backticks. Just the HTML tags.`;

async function cleanWithGemini(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing in .env");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });
  const prompt = CLEAN_PROMPT + "\n\n---\n\n" + text;
  const result = await model.generateContent(prompt);
  const response = result.response;
  if (!response || !response.text) {
    throw new Error("Empty response from Gemini");
  }
  let html = response.text().trim();
  // Strip markdown code blocks if Gemini still adds them
  html = html.replace(/^```(?:html)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  return html;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(APPLY ? "*** APPLY MODE: will update database ***" : "*** DRY RUN: no changes will be made ***");
  if (LIMIT) console.log(`Limit: ${LIMIT} jobs`);

  const query = db("jobs")
    .select("id", "jobName", "companyName", "jobDescription")
    .where("job_status", "approved");
  const jobs = LIMIT ? await query.limit(LIMIT) : await query;

  console.log(`Found ${jobs.length} jobs to process.\n`);

  let updated = 0;
  let failed = 0;
  const results = [];

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
        await db("jobs").where("id", job.id).update({ jobDescription: cleaned });
        updated++;
      } else {
        results.push({
          id: job.id,
          jobName: job.jobName,
          companyName: job.companyName,
          original: desc,
          cleaned: cleaned,
        });
      }

      console.log(`[${i + 1}/${jobs.length}] Job ${job.id} (${job.jobName}): OK`);
    } catch (err) {
      console.error(`[${i + 1}/${jobs.length}] Job ${job.id}: ERROR -`, err.message);
      failed++;
    }

    if (i < jobs.length - 1) await delay(BATCH_DELAY_MS);
  }

  if (!APPLY && results.length > 0) {
    const outputPath = path.join(process.cwd(), "clean-job-results.json");
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf8");
    console.log(`\nResults written to: ${outputPath}`);
  }

  console.log(`\nDone. Updated: ${updated}, Failed: ${failed}`);
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

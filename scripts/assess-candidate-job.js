/**
 * Assess how well a candidate (user) fits a specific job using Gemini.
 * Uses the same logic as admin top-candidates (assessCandidateAlignment).
 *
 * Usage:
 *   node scripts/assess-candidate-job.js <user_uid> <job_id>
 *
 * Example:
 *   node scripts/assess-candidate-job.js abc123 456
 *
 * Requires: .env with GEMINI_API_KEY or GEMINI_CV_READER_API_KEY
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);

const {
  assessCandidateAlignment,
  assessNoCvAlignment,
} = require("../services/geminiCandidateAssessment");
const { extractTextFromCv } = require("../services/cvTextExtractor");

async function main() {
  const userUid = process.argv[2];
  const jobId = process.argv[3];

  if (!userUid || !jobId) {
    console.error("Usage: node scripts/assess-candidate-job.js <user_uid> <job_id>");
    process.exit(1);
  }

  const jobIdNum = parseInt(jobId, 10);
  if (isNaN(jobIdNum)) {
    console.error("Invalid job_id: must be a number");
    process.exit(1);
  }

  const job = await db("jobs")
    .where("id", jobIdNum)
    .select(
      "id",
      "jobName",
      "companyName",
      "jobDescription",
      "job_experience",
      "job_type",
      "job_city",
      "jobSalary"
    )
    .first();

  if (!job) {
    console.error("Job not found for id:", jobIdNum);
    process.exit(1);
  }

  // Normalize for assessment (some code uses job_description)
  if (!job.jobDescription && job.job_description !== undefined) {
    job.job_description = job.job_description;
  }

  const user = await db("users")
    .where("user_uid", userUid)
    .select("user_uid", "user_name", "user_email")
    .first();

  if (!user) {
    console.error("User not found for user_uid:", userUid);
    process.exit(1);
  }

  // Prefer CV-based assessment: get latest resume for this user
  const resume = await db("resumes")
    .where("user_id", userUid)
    .orderBy("updated_at", "desc")
    .select("user_id", "file_url", "file_name")
    .first();

  if (resume) {
    let cvText;
    try {
      cvText = await extractTextFromCv(resume.file_url, resume.file_name);
    } catch (err) {
      console.error("Failed to extract CV text:", err.message);
      process.exit(1);
    }
    if (!cvText || cvText.length < 50) {
      console.error("CV text too short or empty after extraction.");
      process.exit(1);
    }

    const assessment = await assessCandidateAlignment(job, cvText);

    console.log("\n--- Candidate vs Job Assessment ---\n");
    console.log("User:", user.user_name || userUid, `(${userUid})`);
    console.log("Job:", job.jobName || jobIdNum, `#${job.id}`, job.companyName ? `@ ${job.companyName}` : "");
    console.log("\nFit score:", assessment.fit_score, "/ 100");
    console.log("Verdict:", assessment.verdict);
    console.log("\nSummary (Georgian):\n", assessment.summary);
    console.log("\n---\n");
    process.exit(0);
  }

  // No CV: try user_without_cv (table has id, name, email, short_description, categories, other_specify — no user_uid)
  const noCvRow = user.user_email
    ? await db("user_without_cv")
        .where("email", user.user_email)
        .select("id", "name", "short_description", "categories", "other_specify")
        .first()
    : null;

  if (noCvRow) {
    const assessment = await assessNoCvAlignment(job, noCvRow);
    console.log("\n--- Candidate vs Job Assessment (no CV, form only) ---\n");
    console.log("User:", noCvRow.name || userUid, `(${userUid})`);
    console.log("Job:", job.jobName || jobIdNum, `#${job.id}`, job.companyName ? `@ ${job.companyName}` : "");
    console.log("\nFit score:", assessment.fit_score, "/ 100");
    console.log("Verdict:", assessment.verdict);
    console.log("\nSummary (Georgian):\n", assessment.summary);
    console.log("\n---\n");
    process.exit(0);
  }

  console.error("User has no CV and no user_without_cv row. Cannot assess.");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

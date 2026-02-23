#!/usr/bin/env node
/**
 * Get sent emails from the last 7 days (new_job_email_sent), find the jobs they
 * were sent for, run AI vector search + Gemini assessment to find 1 good/strong
 * match per job, then queue "best candidate" follow-up emails spread over 3–4 hours.
 *
 * Usage: node scripts/send-best-candidate-followup-emails.js [--dry-run]
 *   --dry-run: log what would be queued, do not insert into queue
 *
 * Requires: .env with PINECONE_API_KEY, JINA_API_KEY (or embedding env), GEMINI_API_KEY,
 *           MARKETING_MAIL_USER / MARKETING_MAIL_PASS (for queue processor to send later).
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const knexConfig = require("../knexfile");
const { slugify } = require("../utils/slugify");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);

// Relaxed so more jobs get a candidate: larger pool, lower score threshold, no strict role phrase filter
const VECTOR_MIN_SCORE = 0.35;
const VECTOR_TOP_K = 50;
const QUALIFIED_TO_ASSESS = 25; // Assess up to 25 with Gemini before giving up
const SPREAD_HOURS = 5;
const SPREAD_MS = SPREAD_HOURS * 60 * 60 * 1000;
// Start first send 10 min from now so items stay visible in queue before processor picks them up
const START_DELAY_MS = 10 * 60 * 1000;

const BEST_CANDIDATE_HTML = (job, aiDescription) => `
<p>გამარჯობა!</p>

<p>ვხედავ, რომ <b>"${job.jobName}"</b>-ს პოზიციაზე ვაკანსია გაქვთ აქტიური.</p>

<p>Samushao.ge-ს AI-მ ბაზაში უკვე იპოვა რამდენიმე კანდიდატი, რომლებიც თქვენს მოთხოვნებს ემთხვევა.</p>
<p>აი ერთ-ერთის მოკლე დახასიათება (გენერირებულია ჩვენი AI-ს მიერ):</p>
"<i>${aiDescription || "—"}</i>"

<p>მაინტერესებდა, ჯერ კიდევ ეძებთ კადრს?</p>

<p>თუ კი, შემიძლია გამოგიგზავნოთ მისი რეზიუმეს ბმული ან მონაცემები და თავად ნახოთ რამდენად შეესაბამება თქვენს მოთხოვნებს.</p>

<p>პატივისცემით,<br>
გიორგი | Samushao.ge</p>`;

/** Get first GOOD_MATCH or STRONG_MATCH candidate; if none, fall back to first PARTIAL_MATCH. */
async function getOneGoodOrStrongCandidate(job) {
  const { getTopCandidatesForJob } = require("../services/pineconeCandidates");
  const {
    assessCandidateAlignment,
    assessNoCvAlignment,
  } = require("../services/geminiCandidateAssessment");
  const { extractTextFromCv } = require("../services/cvTextExtractor");

  const jobInput = {
    job_role: job.jobName || job.job_role,
    job_experience: job.job_experience,
    job_type: job.job_type,
    job_city: job.job_city,
    jobDescription: job.jobDescription || job.job_description || "",
    requireRoleMatch: false, // Rely on vector similarity + Gemini; literal role phrase filter drops too many good matches
  };
  const matches = await getTopCandidatesForJob(jobInput, VECTOR_TOP_K);
  const qualified = matches
    .filter((m) => (m.score || 0) >= VECTOR_MIN_SCORE)
    .slice(0, QUALIFIED_TO_ASSESS);

  if (qualified.length === 0) return null;

  const realUserIds = qualified
    .filter((m) => !String(m.id).startsWith("no_cv_"))
    .map((m) => m.id);
  const noCvIds = qualified
    .filter((m) => String(m.id).startsWith("no_cv_"))
    .map((m) => parseInt(String(m.id).replace("no_cv_", ""), 10))
    .filter((n) => !isNaN(n) && n > 0);

  const users =
    realUserIds.length > 0
      ? await db("users")
          .whereIn("user_uid", realUserIds)
          .select("user_uid", "user_name", "user_email")
      : [];
  const userMap = Object.fromEntries(users.map((u) => [u.user_uid, u]));

  const resumeRows =
    realUserIds.length > 0
      ? await db("resumes")
          .whereIn("user_id", realUserIds)
          .orderBy("updated_at", "desc")
          .select("user_id", "file_url", "file_name")
      : [];
  const resumeMap = {};
  resumeRows.forEach((r) => {
    if (!resumeMap[r.user_id]) resumeMap[r.user_id] = r;
  });

  const noCvRows =
    noCvIds.length > 0
      ? await db("user_without_cv").whereIn("id", noCvIds).select("*")
      : [];
  const noCvMap = Object.fromEntries(noCvRows.map((r) => [r.id, r]));

  let bestPartial = null; // Fallback: use first PARTIAL_MATCH if no good/strong
  for (const m of qualified) {
    const isNoCv = String(m.id).startsWith("no_cv_");
    let result;
    if (isNoCv) {
      const nid = parseInt(String(m.id).replace("no_cv_", ""), 10);
      const row = noCvMap[nid];
      if (!row) continue;
      try {
        result = await assessNoCvAlignment(job, row);
      } catch (e) {
        continue;
      }
      if (result.verdict === "GOOD_MATCH" || result.verdict === "STRONG_MATCH")
        return { id: m.id, verdict: result.verdict, ai_description: result.summary };
      if (result.verdict === "PARTIAL_MATCH" && !bestPartial)
        bestPartial = { id: m.id, verdict: result.verdict, ai_description: result.summary };
      continue;
    }
    const r = resumeMap[m.id];
    const cvText =
      m.metadata?.text ||
      (r?.file_url
        ? await extractTextFromCv(r.file_url, r.file_name).catch(() => "")
        : "");
    if (!cvText || cvText.length < 50) continue;
    try {
      result = await assessCandidateAlignment(job, cvText);
    } catch (e) {
      continue;
    }
    if (result.verdict === "GOOD_MATCH" || result.verdict === "STRONG_MATCH")
      return { id: m.id, verdict: result.verdict, ai_description: result.summary };
    if (result.verdict === "PARTIAL_MATCH" && !bestPartial)
      bestPartial = { id: m.id, verdict: result.verdict, ai_description: result.summary };
  }
  return bestPartial;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // 1. Sent emails in last 7 days (from new_job_email_sent)
  const sentRows = await db("new_job_email_sent")
    .select("company_email_lower", "sent_at")
    .whereRaw("sent_at >= now() - interval '7 days'")
    .orderBy("sent_at", "desc");

  const companyEmails = [...new Set(sentRows.map((r) => (r.company_email_lower || "").toLowerCase()).filter(Boolean))];
  if (companyEmails.length === 0) {
    console.log("\nNo sent emails in the last 7 days. Nothing to do.\n");
    await db.destroy();
    process.exit(0);
  }

  // 2. Jobs those emails were sent for: same company, marketing_email_sent, approved, not expired
  const placeholders = companyEmails.map(() => "?").join(",");
  const jobs = await db("jobs")
    .select("*")
    .where("job_status", "approved")
    .where("marketing_email_sent", true)
    .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
    .whereRaw(
      `LOWER(TRIM(company_email)) IN (${placeholders})`,
      companyEmails
    )
    .orderBy("id", "asc");

  if (jobs.length === 0) {
    console.log("\nNo matching jobs found for those companies. Nothing to queue.\n");
    await db.destroy();
    process.exit(0);
  }

  console.log(
    `\n[send-best-candidate-followup] Sent emails (last 7 days): ${sentRows.length} → ${companyEmails.length} companies → ${jobs.length} job(s)\n`
  );
  if (dryRun) console.log("  (DRY RUN – no queue inserts)\n");

  const toQueue = [];
  for (const job of jobs) {
    const companyEmail = (job.company_email || "").trim().toLowerCase();
    if (!companyEmail) continue;
    const candidate = await getOneGoodOrStrongCandidate(job);
    if (!candidate) {
      console.log(`  Skip job #${job.id} (${job.jobName}): no good/strong candidate`);
      continue;
    }
    const subject = `კანდიდატი ვაკანსიისთვის "${job.jobName}" - Samushao.ge`;
    const html = BEST_CANDIDATE_HTML(job, candidate.ai_description);
    toQueue.push({
      job_id: job.id,
      jobName: job.jobName,
      company_email_lower: companyEmail,
      subject,
      html,
    });
    console.log(`  Job #${job.id} (${job.jobName}): 1 ${candidate.verdict} → ${companyEmail}`);
  }

  if (toQueue.length === 0) {
    console.log("\nNo jobs with a good/strong candidate. Nothing queued.\n");
    await db.destroy();
    process.exit(0);
  }

  if (dryRun) {
    console.log(`\nWould queue ${toQueue.length} best-candidate follow-up(s) over ${SPREAD_HOURS}h.\n`);
    await db.destroy();
    process.exit(0);
  }

  // Skip jobs that already have a best_candidate_followup row in the queue (avoid duplicate + unique violation)
  const existing = await db("new_job_email_queue")
    .where("email_type", "best_candidate_followup")
    .whereIn(
      "job_id",
      toQueue.map((t) => t.job_id)
    )
    .select("job_id");
  const existingJobIds = new Set((existing || []).map((r) => r.job_id));
  const toInsert = toQueue.filter((t) => !existingJobIds.has(t.job_id));
  if (existingJobIds.size > 0) {
    console.log(
      `  (${existingJobIds.size} job(s) already in queue for best_candidate_followup – skipping)\n`
    );
  }
  if (toInsert.length === 0) {
    console.log("\nNothing new to queue (all already in queue).\n");
    await db.destroy();
    process.exit(0);
  }

  const now = Date.now();
  const slotStep = toInsert.length > 1 ? SPREAD_MS / (toInsert.length - 1) : 0;

  console.log(`Inserting ${toInsert.length} item(s) into new_job_email_queue (email_type=best_candidate_followup)...\n`);

  try {
    for (let i = 0; i < toInsert.length; i++) {
      const sendAfter = new Date(now + START_DELAY_MS + i * slotStep);
      await db("new_job_email_queue").insert({
        job_id: toInsert[i].job_id,
        company_email_lower: toInsert[i].company_email_lower,
        send_after: db.raw("?::timestamptz", [sendAfter.toISOString()]),
        email_type: "best_candidate_followup",
        subject: toInsert[i].subject,
        html: toInsert[i].html,
      });
    }
  } catch (err) {
    console.error("Insert failed:", err.message);
    await db.destroy();
    process.exit(1);
  }

  const countInQueue = await db("new_job_email_queue")
    .where("email_type", "best_candidate_followup")
    .count("id as n")
    .first();
  const n = parseInt(countInQueue?.n || 0, 10);

  console.log(
    `Queued ${toInsert.length} best-candidate follow-up(s). First send in 10 min; spread over ${SPREAD_HOURS}h.\n`
  );
  console.log(
    `There are now ${n} row(s) with email_type=best_candidate_followup in new_job_email_queue. Check /jobs/email-queue-details (or your admin queue view) to see them.\n`
  );
  await db.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

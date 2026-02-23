/**
 * Bulk best-candidate follow-up: get sent emails from last 7 days, find jobs,
 * run vector search + Gemini, queue 1 follow-up per job spread over 5–6 hours.
 * Used by scripts/send-best-candidate-followup-emails.js and POST /jobs/bulk-best-candidate-followup.
 */

const VECTOR_MIN_SCORE = 0.35;
const VECTOR_TOP_K = 50;
const QUALIFIED_TO_ASSESS = 25;
const SPREAD_HOURS = 6;
const SPREAD_MS = SPREAD_HOURS * 60 * 60 * 1000;
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
async function getOneGoodOrStrongCandidate(job, db) {
  const { getTopCandidatesForJob } = require("./pineconeCandidates");
  const {
    assessCandidateAlignment,
    assessNoCvAlignment,
  } = require("./geminiCandidateAssessment");
  const { extractTextFromCv } = require("./cvTextExtractor");

  const jobInput = {
    job_role: job.jobName || job.job_role,
    job_experience: job.job_experience,
    job_type: job.job_type,
    job_city: job.job_city,
    jobDescription: job.jobDescription || job.job_description || "",
    requireRoleMatch: false,
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

  let bestPartial = null;
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

/**
 * Run bulk best-candidate follow-up from last 7 days sent.
 * @param {object} db - Knex instance
 * @param {{ dryRun?: boolean }} opts - dryRun: if true, do not insert into queue
 * @returns {Promise<{ sentRowsCount: number, companyCount: number, jobCount: number, queued: number, skipped: number, alreadyInQueue: number, inserted: number }>}
 */
async function runBulkBestCandidateFollowupFromLast7Days(db, opts = {}) {
  const dryRun = !!opts.dryRun;

  const sentRows = await db("new_job_email_sent")
    .select("company_email_lower", "sent_at")
    .whereRaw("sent_at >= now() - interval '7 days'")
    .orderBy("sent_at", "desc");

  const companyEmails = [
    ...new Set(
      sentRows.map((r) => (r.company_email_lower || "").toLowerCase()).filter(Boolean)
    ),
  ];
  if (companyEmails.length === 0) {
    return {
      sentRowsCount: 0,
      companyCount: 0,
      jobCount: 0,
      queued: 0,
      skipped: 0,
      alreadyInQueue: 0,
      inserted: 0,
    };
  }

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
    return {
      sentRowsCount: sentRows.length,
      companyCount: companyEmails.length,
      jobCount: 0,
      queued: 0,
      skipped: 0,
      alreadyInQueue: 0,
      inserted: 0,
    };
  }

  const toQueue = [];
  for (const job of jobs) {
    const companyEmail = (job.company_email || "").trim().toLowerCase();
    if (!companyEmail) continue;
    const candidate = await getOneGoodOrStrongCandidate(job, db);
    if (!candidate) continue;
    const subject = `კანდიდატი ვაკანსიისთვის "${job.jobName}" - Samushao.ge`;
    const html = BEST_CANDIDATE_HTML(job, candidate.ai_description);
    toQueue.push({
      job_id: job.id,
      jobName: job.jobName,
      company_email_lower: companyEmail,
      subject,
      html,
      best_candidate_id: candidate.id,
    });
  }

  const existing = await db("new_job_email_queue")
    .where("email_type", "best_candidate_followup")
    .whereIn("job_id", toQueue.map((t) => t.job_id))
    .select("job_id");
  const existingJobIds = new Set((existing || []).map((r) => r.job_id));
  const toInsert = toQueue.filter((t) => !existingJobIds.has(t.job_id));

  if (dryRun) {
    return {
      sentRowsCount: sentRows.length,
      companyCount: companyEmails.length,
      jobCount: jobs.length,
      queued: toQueue.length,
      skipped: jobs.length - toQueue.length,
      alreadyInQueue: existingJobIds.size,
      inserted: 0,
      wouldInsert: toInsert.length,
      spreadHours: SPREAD_HOURS,
    };
  }

  if (toInsert.length === 0) {
    return {
      sentRowsCount: sentRows.length,
      companyCount: companyEmails.length,
      jobCount: jobs.length,
      queued: toQueue.length,
      skipped: jobs.length - toQueue.length,
      alreadyInQueue: existingJobIds.size,
      inserted: 0,
    };
  }

  const now = Date.now();
  const slotStep = toInsert.length > 1 ? SPREAD_MS / (toInsert.length - 1) : 0;

  for (let i = 0; i < toInsert.length; i++) {
    const sendAfter = new Date(now + START_DELAY_MS + i * slotStep);
    await db("new_job_email_queue").insert({
      job_id: toInsert[i].job_id,
      company_email_lower: toInsert[i].company_email_lower,
      send_after: db.raw("?::timestamptz", [sendAfter.toISOString()]),
      email_type: "best_candidate_followup",
      subject: toInsert[i].subject,
      html: toInsert[i].html,
      best_candidate_id: toInsert[i].best_candidate_id ?? null,
    });
  }

  return {
    sentRowsCount: sentRows.length,
    companyCount: companyEmails.length,
    jobCount: jobs.length,
    queued: toQueue.length,
    skipped: jobs.length - toQueue.length,
    alreadyInQueue: existingJobIds.size,
    inserted: toInsert.length,
    spreadHours: SPREAD_HOURS,
  };
}

module.exports = {
  runBulkBestCandidateFollowupFromLast7Days,
  SPREAD_HOURS,
};

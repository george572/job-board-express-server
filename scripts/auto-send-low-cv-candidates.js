/**
 * Automated: Find jobs posted < 4 days ago with < 5 CVs sent,
 * get good match candidates, send to HRs.
 * Run daily via cron to send within 3-4 days of posting.
 *
 * Usage: node scripts/auto-send-low-cv-candidates.js [--dry-run]
 *   --dry-run: log what would be sent, do not send
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const nodemailer = require("nodemailer");
const knexConfig = require("../knexfile");
const { slugify } = require("../utils/slugify");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://samushao.ge";

const DAYS_SINCE_POST = 4;
const MAX_CVS_SENT = 5;
const CANDIDATES_PER_JOB = 4;
const VECTOR_MIN_SCORE = 0.4;
const VECTOR_TOP_K = 20;

const MARKETING_MAIL_USER = (
  process.env.APPLICANTS_MAIL_USER ||
  process.env.MARKETING_MAIL_USER ||
  ""
).trim();
const MARKETING_MAIL_PASS = (
  process.env.APPLICANTS_MAIL_PASS ||
  process.env.MARKETING_MAIL_PASS ||
  ""
)
  .trim()
  .replace(/\s/g, "");

const marketingTransporter =
  MARKETING_MAIL_USER && MARKETING_MAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: MARKETING_MAIL_USER, pass: MARKETING_MAIL_PASS },
      })
    : null;

async function getTopGoodCandidatesForJob(job, limit = 4) {
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
    requireRoleMatch: true,
  };
  const matches = await getTopCandidatesForJob(jobInput, VECTOR_TOP_K);
  const qualified = matches
    .filter((m) => (m.score || 0) >= VECTOR_MIN_SCORE)
    .slice(0, 10);

  if (qualified.length === 0) return [];

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

  const assessed = [];
  for (const m of qualified) {
    const isNoCv = String(m.id).startsWith("no_cv_");
    if (isNoCv) {
      const nid = parseInt(String(m.id).replace("no_cv_", ""), 10);
      const row = noCvMap[nid];
      if (!row) continue;
      try {
        const result = await assessNoCvAlignment(job, row);
        assessed.push({
          id: m.id,
          verdict: result.verdict,
          ai_description: result.summary,
          name: row.name,
          email: row.email,
          phone: row.phone,
          cv_url: null,
          cv_file_name: null,
        });
      } catch (e) {
        // skip
      }
    } else {
      const r = resumeMap[m.id];
      const cvText =
        m.metadata?.text ||
        (r?.file_url
          ? await extractTextFromCv(r.file_url, r.file_name).catch(() => "")
          : "");
      if (!cvText || cvText.length < 50) continue;
      try {
        const result = await assessCandidateAlignment(job, cvText);
        const u = userMap[m.id];
        assessed.push({
          id: m.id,
          verdict: result.verdict,
          ai_description: result.summary,
          name: u?.user_name || null,
          email: u?.user_email || null,
          phone: null,
          cv_url: r?.file_url || null,
          cv_file_name: r?.file_name || null,
        });
      } catch (e) {
        // skip
      }
    }
  }

  const goodOrStrong = assessed.filter(
    (a) => a.verdict === "GOOD_MATCH" || a.verdict === "STRONG_MATCH",
  );
  return goodOrStrong.slice(0, limit);
}

function toHrEmailUser(c) {
  return {
    user_name: c.name,
    user_email: c.email,
    phone: c.phone,
    userSummary: c.ai_description,
    cv_url: c.cv_url,
  };
}

async function sendHrEmail(payload) {
  if (!marketingTransporter || !payload.hr_email || !payload.job_name) return;
  const list = payload.users_list || [];
  const usersText =
    list.length > 0
      ? list
          .map((u) => {
            const name = u.user_name ?? u.userName ?? u.name ?? "—";
            const email = u.user_email ?? u.userEmail ?? u.email ?? "—";
            const phone = u.phone ?? "";
            const url = u.cv_url ?? u.cvUrl ?? u.resume_url ?? u.file_url ?? "";
            const summary =
              u.user_summary ?? u.userSummary ?? u.summary ?? "";
            const lines = [`სახელი : ${name}`, `იმეილი : ${email}`];
            if (phone && phone.trim() && phone !== "—")
              lines.push(`ტელეფონი : ${phone}`);
            if (url && url.trim() && url !== "—")
              lines.push(`CV ლინკი : ${url}`);
            if (summary && summary.trim() && summary !== "—")
              lines.push(`AI შეფასება : ${summary}`);
            return lines.join("\n");
          })
          .join("\n\n")
      : "";
  const candidatesBlock =
    list.length === 1
      ? `კანდიდატი:\n\n${usersText}\n\n`
      : list.length > 0
        ? `კანდიდატები:\n\n${usersText}\n\n`
        : "";
  const countLine =
    list.length > 0
      ? `ჩვენ ვიპოვეთ ${list.length} კარგი კანდიდატი თქვენი ვაკანსიისთვის.`
      : "ჩვენ ვიპოვეთ რამდენიმე კარგი კანდიდატი თქვენი ვაკანსიისთვის.";
  const text = `

${countLine}

გაითვალისწინეთ, საუკეთესო კანდიდატები გამოიგზავნა ავტომატურად,
ჩვენ არ ვიცით ეს კანდიდატები დათანხმდებიან თუ არა თქვენთან მუშაობას.
თქვენ თავად უნდა შეეხმიანოთ მათ.

${candidatesBlock}

პატივისცემით,
გიორგი | Samushao.ge`;

  await marketingTransporter.sendMail({
    from: `"Giorgi Khutiashvili - Samushao.ge" <${MARKETING_MAIL_USER || "giorgi@samushao.ge"}>`,
    to: payload.hr_email.trim(),
    subject: `კანდიდატები ვაკანსია ${payload.job_name}-სთვის.`,
    text,
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_SINCE_POST);

  const jobs = await db("jobs")
    .whereIn("job_premium_status", ["premium", "premiumPlus"])
    .where("job_status", "approved")
    .where("created_at", ">=", cutoff)
    .where((qb) => {
      qb.where("cvs_sent", "<", MAX_CVS_SENT)
        .orWhereNull("cvs_sent");
    })
    .select(
      "id",
      "jobName",
      "companyName",
      "company_email",
      "cvs_sent",
      "created_at",
      "jobDescription",
      "job_description",
      "job_experience",
      "job_type",
      "job_city",
    )
    .orderBy("created_at", "desc");

  console.log(
    `\n[auto-send-low-cv] Jobs: posted < ${DAYS_SINCE_POST} days, cvs_sent < ${MAX_CVS_SENT}: ${jobs.length} found`,
  );
  if (dryRun) console.log("  (DRY RUN – no emails sent)\n");

  let sent = 0;
  for (const job of jobs) {
    if (!job.company_email) continue;
    const candidates = await getTopGoodCandidatesForJob(job, CANDIDATES_PER_JOB);
    if (candidates.length === 0) continue;

    const jobLink = `${SITE_BASE_URL}/vakansia/${slugify(job.jobName)}-${job.id}`;
    const payload = {
      hr_email: job.company_email,
      job_name: job.jobName,
      job_id: job.id,
      company_name: job.companyName,
      job_link: jobLink,
      users_list: candidates.map(toHrEmailUser),
    };

    if (dryRun) {
      console.log(
        `  [dry-run] Would send to ${job.company_email} (job #${job.id}: ${job.jobName}, ${candidates.length} candidates)`,
      );
      sent++;
      continue;
    }

    try {
      await sendHrEmail(payload);
      await db("jobs")
        .where("id", job.id)
        .increment("cvs_sent", candidates.length);
      console.log(
        `  ✓ Sent to ${job.company_email} (job #${job.id}: ${job.jobName}, ${candidates.length} candidates)`,
      );
      sent++;
    } catch (err) {
      console.error(`  ✗ Job #${job.id}: ${err.message}`);
    }
  }

  console.log(`\n[auto-send-low-cv] Done. Sent ${sent} email(s).\n`);
  await db.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

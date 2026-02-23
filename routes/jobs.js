const cors = require("cors");
const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");
const router = express.Router();
router.use(cors());
const multer = require("multer");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { slugify } = require("../utils/slugify");
const { JOBS_LIST_COLUMNS } = require("../utils/jobColumns");
const { upsertJob, deleteJob } = require("../services/pineconeJobs");
const { invalidate: invalidateFilterCountsCache } = require("../services/filterCountsCache");
const { parsePremiumUntil } = require("../utils/parsePremiumUntil");

let db;

// Email for freshly uploaded jobs (to HR)
const NEW_JOB_MAIL_USER = (process.env.PROPOSITIONAL_MAIL_USER || "").trim();
const NEW_JOB_MAIL_PASS = (process.env.PROPOSITIONAL_MAIL_PASS || "")
  .trim()
  .replace(/\s/g, "");
// Marketing email (3rd CV, from giorgi@samushao.ge)
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
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://samushao.ge";
const EMAIL_SIGNATURE = (process.env.EMAIL_SIGNATURE || "").trim();

let blacklistCache = { emails: new Set(), companyNames: new Set() };
let blacklistLoaded = false;

async function loadBlacklist() {
  try {
    const rows = await db("blacklisted_company_emails").select(
      "email",
      "company_name",
    );
    const emails = new Set();
    const companyNames = new Set();
    rows.forEach((r) => {
      const e = (r.email || "").trim().toLowerCase();
      const c = (r.company_name || "").trim().toLowerCase();
      if (e) emails.add(e);
      if (c) companyNames.add(c);
    });
    blacklistCache = { emails, companyNames };
    blacklistLoaded = true;
    return blacklistCache;
  } catch (e) {
    if (e.code !== "42P01") console.error("loadBlacklist error:", e.message);
    blacklistLoaded = true;
    return blacklistCache;
  }
}

async function isBlacklisted(jobOrEmail, companyName) {
  const email = (
    typeof jobOrEmail === "string"
      ? jobOrEmail
      : jobOrEmail?.company_email || ""
  )
    .trim()
    .toLowerCase();
  const name =
    (
      companyName ??
      (typeof jobOrEmail === "object" ? jobOrEmail?.companyName : "")
    )
      ?.trim()
      .toLowerCase() || "";
  if (!email && !name) return false;
  if (!blacklistLoaded) await loadBlacklist();
  if (email && blacklistCache.emails.has(email)) return true;
  if (name && blacklistCache.companyNames.has(name)) return true;
  return false;
}

async function refreshBlacklistCache() {
  blacklistLoaded = false;
  return loadBlacklist();
}

const newJobTransporter =
  NEW_JOB_MAIL_USER && NEW_JOB_MAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: NEW_JOB_MAIL_USER, pass: NEW_JOB_MAIL_PASS },
      })
    : null;

const marketingTransporter =
  MARKETING_MAIL_USER && MARKETING_MAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: MARKETING_MAIL_USER, pass: MARKETING_MAIL_PASS },
      })
    : null;

// Marketing email scheduling: all times in Tbilisi (Asia/Tbilisi, UTC+4)
const TZ_GEORGIA = "Asia/Tbilisi";
function isAfter1830() {
  const pts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_GEORGIA,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const hour = parseInt(pts.find((p) => p.type === "hour").value, 10);
  const minute = parseInt(pts.find((p) => p.type === "minute").value, 10);
  // Defer to next morning only when between 18:30 and 00:00 Georgia time
  return hour > 18 || (hour === 18 && minute >= 30);
}
/** Returns Date for next calendar day 10:00 Tbilisi, stored as UTC (10:00 Tbilisi = 06:00 UTC) */
function getNextDay1020Georgia() {
  const now = new Date();
  const opts = {
    timeZone: TZ_GEORGIA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(now);
  const y = parseInt(parts.find((p) => p.type === "year").value, 10);
  const m = parseInt(parts.find((p) => p.type === "month").value, 10);
  const d = parseInt(parts.find((p) => p.type === "day").value, 10);
  return new Date(Date.UTC(y, m - 1, d + 1, 6, 0, 0)); // 06:00 UTC = 10:00 Tbilisi
}
/** Returns Date for next calendar day 10:00 Tbilisi (06:00 UTC) */
function getNextDay0900Georgia() {
  const now = new Date();
  const opts = {
    timeZone: TZ_GEORGIA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(now);
  const y = parseInt(parts.find((p) => p.type === "year").value, 10);
  const m = parseInt(parts.find((p) => p.type === "month").value, 10);
  const d = parseInt(parts.find((p) => p.type === "day").value, 10);
  return new Date(Date.UTC(y, m - 1, d + 1, 6, 0, 0)); // 06:00 UTC = 10:00 Tbilisi
}

// Bulk emails spread over 2 hours
const BULK_SPREAD_MS = 2 * 60 * 60 * 1000; // 2 hours total window
const MIN_DELAY_BETWEEN_SENDS_MS = 60 * 1000; // at least 1 min between sends
const MAX_DELAY_BETWEEN_SENDS_MS = 5 * 60 * 1000; // random 1–5 min before next check
const RESCHEDULE_SLOT_MINUTES = 7; // 7 min between rescheduled emails (09:00, 09:07, 09:14…)

let newJobEmailLastSentAt = 0;
let newJobEmailProcessorScheduled = false;

async function hasRecentlySentToCompany(companyEmail) {
  if (!companyEmail) return false;
  try {
    const row = await db("new_job_email_sent")
      .where("company_email_lower", companyEmail)
      .whereRaw("sent_at > now() - interval '7 days'")
      .first();
    return !!row;
  } catch (e) {
    console.error("hasRecentlySentToCompany error:", e.message);
    return false;
  }
}

async function claimAndSendToCompany(companyEmail) {
  if (!companyEmail) return false;
  try {
    const result = await db.raw(
      `INSERT INTO new_job_email_sent (company_email_lower, sent_at)
       VALUES (?, now())
       ON CONFLICT (company_email_lower)
       DO UPDATE SET sent_at = now()
       WHERE new_job_email_sent.sent_at < now() - interval '7 days'
       RETURNING company_email_lower`,
      [companyEmail],
    );
    return result.rows && result.rows.length > 0;
  } catch (e) {
    console.error("claimAndSendToCompany error:", e.message);
    return false;
  }
}

async function getQueueCount() {
  try {
    const r = await db("new_job_email_queue").count("id as n").first();
    return parseInt(r?.n || 0, 10);
  } catch (e) {
    if (e.code === "42P01") return 0; // table doesn't exist yet
    console.error("getQueueCount error:", e.message);
    return 0;
  }
}

// Start processor on startup if queue has items
const RETRY_WHEN_NO_TRANSPORTER_MS = 5 * 60 * 1000; // 5 min
const MAX_WAIT_BEFORE_RECHECK_MS = 60 * 1000; // Wake every 1 min when all items deferred
const POLL_INTERVAL_MS = 60 * 1000; // Fallback: poll every 1 min no matter what

function initEmailQueue() {
  (async () => {
    const n = await getQueueCount();
    const transportOk = !!newJobTransporter;
    console.log(
      `[Email queue] Startup: ${n} items in queue, transporter: ${transportOk ? "configured" : "NOT CONFIGURED (set PROPOSITIONAL_MAIL_USER/PASS)"}`,
    );
    if (n > 0) {
      newJobEmailProcessorScheduled = true;
      processNewJobEmailQueue();
      setInterval(() => {
        getQueueCount().then((c) => {
          if (c > 0) {
            newJobEmailProcessorScheduled = true;
            processNewJobEmailQueue();
          }
        });
      }, POLL_INTERVAL_MS);
    }
  })();
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function processNewJobEmailQueue() {
  try {
    const count = await getQueueCount();
    if (count === 0) {
      newJobEmailProcessorScheduled = false;
      return;
    }
    // Compare: send_after <= NOW() (both UTC in DB)
    const debug = await db
      .raw(
        "SELECT NOW() as db_now, (SELECT send_after FROM new_job_email_queue ORDER BY send_after LIMIT 1) as first_send_after",
      )
      .then((r) => r.rows?.[0]);
    if (debug) {
      console.log(
        `[Email queue] DB now: ${debug.db_now}, first send_after: ${debug.first_send_after}`,
      );
    }
    const row = await db("new_job_email_queue as q")
      .leftJoin("jobs as j", "j.id", "q.job_id")
      .select(
        "q.id as queue_id",
        "q.job_id",
        "q.company_email_lower",
        "q.send_after",
        "q.email_type",
        "q.subject",
        "q.html",
        "q.best_candidate_id",
        "j.jobName",
        "j.companyName",
        "j.company_email",
        "j.jobSalary",
        "j.jobSalary_min",
      )
      .whereRaw("q.send_after <= NOW()")
      .orderBy("q.send_after")
      .first();
    if (!row) {
      const nextRow = await db("new_job_email_queue")
        .select("send_after")
        .orderBy("send_after")
        .first();
      if (nextRow) {
        const idealWait = new Date(nextRow.send_after).getTime() - Date.now();
        const waitMs = Math.min(
          Math.max(MIN_DELAY_BETWEEN_SENDS_MS, idealWait),
          MAX_WAIT_BEFORE_RECHECK_MS,
        );
        console.log(
          `[Email queue] All ${count} items scheduled for later; recheck in ${Math.round(waitMs / 1000)}s`,
        );
        newJobEmailProcessorScheduled = true;
        setTimeout(processNewJobEmailQueue, waitMs);
      } else {
        newJobEmailProcessorScheduled = false;
      }
      return;
    }
    // No sends after 18:00 Georgia: reschedule to next day 10:00, 10:07, 10:14… (spread)
    if (isAfter1830()) {
      const next0900 = getNextDay0900Georgia();
      const windowEnd = new Date(next0900.getTime() + BULK_SPREAD_MS);
      const existingCount = await db("new_job_email_queue")
        .whereBetween("send_after", [
          next0900.toISOString(),
          windowEnd.toISOString(),
        ])
        .count("id as n")
        .first()
        .then((r) => parseInt(r?.n || 0, 10));
      const offsetMs = existingCount * RESCHEDULE_SLOT_MINUTES * 60 * 1000;
      const newSendAfter = new Date(next0900.getTime() + offsetMs);
      await db("new_job_email_queue")
        .where("id", row.queue_id)
        .update({
          send_after: db.raw("?::timestamptz", [newSendAfter.toISOString()]),
        });
      console.log(
        `[Email queue] Rescheduled job #${row.job_id} to next day ${new Date(newSendAfter).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ_GEORGIA })} (slot ${existingCount + 1}, was due after 18:30)`,
      );
      newJobEmailProcessorScheduled = true;
      setTimeout(processNewJobEmailQueue, MIN_DELAY_BETWEEN_SENDS_MS);
      return;
    }
    const companyEmail = (row.company_email_lower || "").trim().toLowerCase();
    const isThirdCvMarketing = row.email_type === "third_cv_marketing";

    if (isThirdCvMarketing) {
      // Third CV marketing: use stored subject/html, marketing transporter
      if (!marketingTransporter || !companyEmail || !row.subject || !row.html) {
        await db("new_job_email_queue").where("id", row.queue_id).del();
        processNewJobEmailQueue();
        return;
      }
      const mailOptions = {
        from: MARKETING_MAIL_USER,
        to: companyEmail,
        subject: row.subject,
        html: row.html,
      };
      marketingTransporter.sendMail(mailOptions, async (err) => {
        if (err) {
          console.error("Third CV marketing email error:", err);
        } else {
          const hasCvSubmissions = await db.schema.hasColumn(
            "jobs",
            "cv_submissions_email_sent",
          );
          if (hasCvSubmissions) {
            await db("jobs")
              .where("id", row.job_id)
              .update({ cv_submissions_email_sent: true });
          }
          console.log(
            `📧 Sent third-CV marketing email to ${companyEmail} (job #${row.job_id})`,
          );
        }
        await db("new_job_email_queue").where("id", row.queue_id).del();
        newJobEmailLastSentAt = Date.now();
        const nextDelay = randomBetween(
          MIN_DELAY_BETWEEN_SENDS_MS,
          MAX_DELAY_BETWEEN_SENDS_MS,
        );
        newJobEmailProcessorScheduled = true;
        setTimeout(processNewJobEmailQueue, nextDelay);
      });
      return;
    }

    const isBestCandidateFollowup = row.email_type === "best_candidate_followup";
    if (isBestCandidateFollowup) {
      if (!marketingTransporter || !companyEmail || !row.subject || !row.html) {
        await db("new_job_email_queue").where("id", row.queue_id).del();
        processNewJobEmailQueue();
        return;
      }
      const mailOptions = {
        from: MARKETING_MAIL_USER,
        to: companyEmail,
        subject: row.subject,
        html: row.html,
      };
      marketingTransporter.sendMail(mailOptions, async (err) => {
        if (err) {
          console.error("Best candidate follow-up email error:", err);
        } else {
          console.log(
            `📧 Sent best-candidate follow-up to ${companyEmail} (job #${row.job_id})`,
          );
        }
        await db("new_job_email_queue").where("id", row.queue_id).del();
        newJobEmailLastSentAt = Date.now();
        const nextDelay = randomBetween(
          MIN_DELAY_BETWEEN_SENDS_MS,
          MAX_DELAY_BETWEEN_SENDS_MS,
        );
        newJobEmailProcessorScheduled = true;
        setTimeout(processNewJobEmailQueue, nextDelay);
      });
      return;
    }

    if (companyEmail && (await hasRecentlySentToCompany(companyEmail))) {
      console.log(
        `[Email queue] Skip job #${row.job_id} → ${companyEmail}: already sent in last 7 days`,
      );
      await db("new_job_email_queue").where("id", row.queue_id).del();
      processNewJobEmailQueue();
      return;
    }
    const claimed = companyEmail && (await claimAndSendToCompany(companyEmail));
    if (companyEmail && !claimed) {
      console.log(
        `[Email queue] Skip job #${row.job_id} → ${companyEmail}: claim failed (another process or rate limit)`,
      );
      await db("new_job_email_queue").where("id", row.queue_id).del();
      processNewJobEmailQueue();
      return;
    }
    if (!newJobTransporter) {
      console.error(
        "[Email queue] PROPOSITIONAL_MAIL_USER/PASS not set – NOT deleting queue item, will retry in 5 min. Set env vars to send emails.",
      );
      newJobEmailProcessorScheduled = true;
      setTimeout(processNewJobEmailQueue, RETRY_WHEN_NO_TRANSPORTER_MS);
      return;
    }
    const job = {
      id: row.job_id,
      jobName: row.jobName,
      companyName: row.companyName,
      company_email: row.company_email || companyEmail,
      jobSalary: row.jobSalary,
      jobSalary_min: row.jobSalary_min,
    };
    newJobEmailLastSentAt = Date.now();
    const jobLink = `${SITE_BASE_URL}/vakansia/${slugify(job.jobName)}-${job.id}`;
    const toEmail =
      (job.company_email || "").trim().split(/[,;]/)[0].trim() || companyEmail;
    const subject =
      row.subject || `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`;
    const html =
      row.html ||
      NEW_JOB_HTML_TEMPLATE(
        { ...job, jobLink },
        { ai_description: "—" },
      );
    const mailOptions = {
      from: NEW_JOB_MAIL_USER,
      to: toEmail || job.company_email?.trim(),
      subject,
      html,
    };
    newJobTransporter.sendMail(mailOptions, async (err) => {
      if (err) {
        console.error("New job email error:", err);
      } else {
        await db("jobs")
          .where("id", row.job_id)
          .update({ marketing_email_sent: true });
        console.log(
          `📧 Sent new-job email to ${job.company_email?.trim()} (job #${job.id}: ${job.jobName})`,
        );
      }
      await db("new_job_email_queue").where("id", row.queue_id).del();
      newJobEmailLastSentAt = Date.now();
      const nextDelay = randomBetween(
        MIN_DELAY_BETWEEN_SENDS_MS,
        MAX_DELAY_BETWEEN_SENDS_MS,
      );
      newJobEmailProcessorScheduled = true;
      setTimeout(processNewJobEmailQueue, nextDelay);
    });
  } catch (e) {
    console.error("processNewJobEmailQueue error:", e.message);
    newJobEmailProcessorScheduled = false;
  }
}

// Helper: extract numeric salary for comparison (e.g. "1500-2000" → 1500, "1200" → 1200)
function parseSalaryNum(s) {
  if (s == null || s === "") return null;
  const m = String(s).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

const NEW_JOB_HTML_TEMPLATE_BEST_CANDIDATE = (job, candidate) => {
  const aiDescription =
    candidate && candidate.ai_description
      ? candidate.ai_description
      : "—";
  return `
<p>გამარჯობა!</p>

<p>ვხედავ, რომ <b>"${job.jobName}"</b>-ს პოზიციაზე ვაკანსია გაქვთ აქტიური.</p>

<p>Samushao.ge-ს AI-მ ბაზაში უკვე იპოვა რამდენიმე კანდიდატი, რომლებიც თქვენს მოთხოვნებს ემთხვევა.</p>
<p>აი ერთ-ერთის მოკლე დახასიათება (გენერირებულია ჩვენი AI-ს მიერ):</p>
"<i>${aiDescription}</i>"

<p>მაინტერესებდა, ჯერ კიდევ ეძებთ კადრს?</p>

<p>თუ კი, შემიძლია გამოგიგზავნოთ მისი რეზიუმეს ბმული ან მონაცემები და თავად ნახოთ რამდენად შეესაბამება თქვენს მოთხოვნებს.</p>

<p>პატივისცემით,<br>
გიორგი | Samushao.ge</p>`;
};

const NEW_JOB_HTML_TEMPLATE_PARTIAL_MATCH = (job, candidate) => {
  const aiDescription =
    candidate && candidate.ai_description
      ? candidate.ai_description
      : "—";
  return `
<p>გამარჯობა!</p>

<p>ვხედავ, რომ <b>"${job.jobName}"</b>-ს პოზიციაზე ვაკანსია გაქვთ აქტიური.</p>
<p>ცოტა რთულია ამ პოზიციაზე კანდიდატების პოვნა...</p>
<p>თუმცა Samushao.ge-ს AI-მ ბაზაში უკვე იპოვა რამდენიმე კანდიდატი, რომლებიც თქვენს მოთხოვნებს მეტნაკლებად ემთხვევა.</p>
<p>აი ერთ-ერთის მოკლე დახასიათება (გენერირებულია ჩვენი AI-ს მიერ):</p>
"<i>${aiDescription}</i>"

<p>მაინტერესებდა, ჯერ კიდევ ეძებთ კადრს?</p>

<p>თუ კი, შემიძლია გამოგიგზავნოთ მისი რეზიუმეს ბმული ან მონაცემები და თავად ნახოთ რამდენად შეესაბამება თქვენს მოთხოვნებს.</p>

<p>პატივისცემით,<br>
გიორგი | Samushao.ge</p>`;
};

// Fallback when stored html is missing (legacy queue rows)
const NEW_JOB_HTML_TEMPLATE = NEW_JOB_HTML_TEMPLATE_BEST_CANDIDATE;

const VECTOR_MIN_SCORE = 0.4;
const VECTOR_TOP_K = 20;

/**
 * Evaluate job for new-job marketing email: vector search + Gemini assessment.
 * Returns { shouldQueue, bestCandidate?, matchType?, reason? }
 * - If >= 2 good/strong: use first STRONG_MATCH or GOOD_MATCH, template BEST_CANDIDATE.
 * - Else if >= 1 partial: use first PARTIAL_MATCH, template PARTIAL_MATCH.
 * - Skip only if we can't find any candidate.
 */
async function evaluateJobForNewJobEmail(job) {
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
    jobDescription:
      job.jobDescription || job.job_description || "",
    requireRoleMatch: true,
  };
  const matches = await getTopCandidatesForJob(jobInput, VECTOR_TOP_K);
  const qualified = matches
    .filter((m) => (m.score || 0) >= VECTOR_MIN_SCORE)
    .slice(0, 10);

  if (qualified.length === 0) {
    return { shouldQueue: false, reason: "no candidates found" };
  }

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
        console.warn(
          `[evaluateJob] assessNoCvAlignment failed for no_cv_${nid}:`,
          e.message,
        );
      }
    } else {
      const r = resumeMap[m.id];
      const cvText =
        m.metadata?.text ||
        (r?.file_url
          ? await extractTextFromCv(r.file_url, r.file_name).catch(() => "")
          : "");
      if (!cvText || cvText.length < 50) {
        continue;
      }
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
        console.warn(
          `[evaluateJob] assessCandidateAlignment failed for ${m.id}:`,
          e.message,
        );
      }
    }
  }

  const goodMatches = assessed.filter((a) => a.verdict === "GOOD_MATCH");
  const strongMatches = assessed.filter((a) => a.verdict === "STRONG_MATCH");
  const partialMatches = assessed.filter((a) => a.verdict === "PARTIAL_MATCH");

  let best;
  let matchType;

  if (strongMatches.length >= 1 || goodMatches.length >= 1) {
    best = strongMatches[0] || goodMatches[0];
    matchType = "good_or_strong";
  } else if (partialMatches.length >= 1) {
    best = partialMatches[0];
    matchType = "partial";
  } else {
    return {
      shouldQueue: false,
      reason: "no good/strong or partial match candidates found",
    };
  }

  if (!best) {
    return { shouldQueue: false, reason: "no suitable candidate found" };
  }

  return {
    shouldQueue: true,
    matchType,
    bestCandidate: {
      id: best.id,
      ai_description: best.ai_description,
      name: best.name,
      email: best.email,
      phone: best.phone,
      cv_url: best.cv_url,
      cv_file_name: best.cv_file_name,
    },
  };
}

/** Top N good/strong candidates for a job (for premium-low-cv report). */
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
    jobDescription:
      job.jobDescription || job.job_description || "",
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

/**
 * Add job to queue with sendAfter time.
 * @param {object} job
 * @param {object} opts - { batchIndex, batchTotal, bestCandidate } - bestCandidate required for new flow
 * @returns {{ queued: boolean; reason?: string }}
 */
async function sendNewJobEmail(job, opts = {}) {
  if (!newJobTransporter || !job.company_email || job.dont_send_email) {
    return { queued: false, reason: "no_transporter_or_email" };
  }
  const companyEmail = (job.company_email || "").trim().toLowerCase();
  if (!companyEmail) return { queued: false, reason: "no_email" };
  try {
    const existingJob = await db("new_job_email_queue")
      .where("job_id", job.id)
      .where((qb) =>
        qb.where("email_type", "new_job").orWhereNull("email_type"),
      )
      .first();
    if (existingJob) return { queued: false, reason: "duplicate_job_in_queue" };
    const existingCompany = await db("new_job_email_queue")
      .where("company_email_lower", companyEmail)
      .where((qb) =>
        qb.where("email_type", "new_job").orWhereNull("email_type"),
      )
      .first();
    if (existingCompany)
      return { queued: false, reason: "company_already_in_queue" };
  } catch (e) {
    if (e.code === "42P01") {
      /* table doesn't exist yet */
    } else throw e;
  }
  if (await hasRecentlySentToCompany(companyEmail)) {
    return { queued: false, reason: "already_sent_last_7_days" };
  }

  const now = Date.now();
  let sendAfterMs;
  if (
    opts.batchTotal != null &&
    opts.batchTotal > 0 &&
    opts.batchIndex != null
  ) {
    const totalWindow = BULK_SPREAD_MS;
    const slotSize = totalWindow / opts.batchTotal;
    const base = opts.batchIndex * slotSize;
    const jitter = (Math.random() - 0.5) * slotSize * 0.4;
    // Bulk uploads: only defer to next morning when between 18:30 and 00:00 Georgia; otherwise spread over next 2h from now
    const deferToNextDay = isAfter1830();
    const baseTime = deferToNextDay ? getNextDay1020Georgia().getTime() : now;
    sendAfterMs = baseTime + Math.max(0, base + jitter);
  } else {
    const deferToNextDay = isAfter1830();
    sendAfterMs = deferToNextDay ? getNextDay1020Georgia().getTime() : now;
  }
  const sendAfter = new Date(sendAfterMs);
  const bestCandidate = opts.bestCandidate || null;

  const insertPayload = {
    job_id: job.id,
    company_email_lower: companyEmail,
    send_after: db.raw("?::timestamptz", [sendAfter.toISOString()]),
    email_type: "new_job",
  };
  if (bestCandidate) {
    const jobLink = `${SITE_BASE_URL}/vakansia/${slugify(job.jobName)}-${job.id}`;
    const candidateData = { ai_description: bestCandidate.ai_description };
    const htmlTemplate =
      opts.matchType === "partial"
        ? NEW_JOB_HTML_TEMPLATE_PARTIAL_MATCH
        : NEW_JOB_HTML_TEMPLATE_BEST_CANDIDATE;
    const html = htmlTemplate({ ...job, jobLink }, candidateData);
    insertPayload.best_candidate_id = bestCandidate.id;
    insertPayload.subject = `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`;
    insertPayload.html = html;
  }

  await db("new_job_email_queue").insert(insertPayload);
  if (!newJobEmailProcessorScheduled) {
    newJobEmailProcessorScheduled = true;
    processNewJobEmailQueue();
  }
  return { queued: true };
}

/**
 * Send one email per company when multiple jobs are uploaded (bulk).
 * Evaluates the first job for candidates, then queues if conditions met.
 * @returns {{ queued: boolean; reason?: string }}
 */
async function sendNewJobEmailToCompany(jobs, batchIndex, batchTotal) {
  if (!newJobTransporter || !Array.isArray(jobs) || jobs.length === 0) {
    return { queued: false, reason: "no_transporter_or_empty" };
  }
  const first = jobs[0];
  const email = (first.company_email || "").trim();
  if (!email || first.dont_send_email) {
    return { queued: false, reason: "no_email_or_dont_send" };
  }
  const fullJob = await db("jobs")
    .where("id", first.id)
    .select("*")
    .first();
  if (!fullJob) return { queued: false, reason: "job_not_found" };

  const evalResult = await evaluateJobForNewJobEmail(fullJob).catch((e) => {
    console.error("[evaluateJob] Bulk failed for job", first.id, ":", e.message);
    return { shouldQueue: false, reason: e.message };
  });

  if (!evalResult.shouldQueue || !evalResult.bestCandidate) {
    return { queued: false, reason: evalResult.reason || "no_suitable_candidates" };
  }

  return sendNewJobEmail(
    {
      id: first.id,
      jobName: first.jobName,
      companyName: first.companyName,
      company_email: first.company_email,
      jobSalary: first.jobSalary,
      dont_send_email: first.dont_send_email,
    },
    {
      batchIndex,
      batchTotal,
      bestCandidate: evalResult.bestCandidate,
      matchType: evalResult.matchType,
    },
  );
}

router.get("/", async (req, res) => {
  try {
    const {
      category,
      company,
      job_experience,
      job_city,
      job_type,
      page = 1,
      limit = 10,
      hasSalary,
      job_premium_status,
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);

    let query = db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())");

    // Apply filters
    if (company) query.where("companyName", company);
    if (category)
      query.whereIn(
        "category_id",
        Array.isArray(category) ? category : [category],
      );
    if (job_experience)
      query.whereIn(
        "job_experience",
        Array.isArray(job_experience) ? job_experience : [job_experience],
      );
    if (job_city)
      query.whereIn(
        "job_city",
        Array.isArray(job_city) ? job_city : [job_city],
      );
    if (job_type)
      query.whereIn(
        "job_type",
        Array.isArray(job_type) ? job_type : [job_type],
      );
    if (hasSalary === "true") query.whereNotNull("jobSalary");
    if (job_premium_status)
      query.whereIn(
        "job_premium_status",
        Array.isArray(job_premium_status)
          ? job_premium_status
          : [job_premium_status],
      );

    const jobs = await query
      .orderByRaw(
        `CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`,
      )
      .orderBy("created_at", "desc")
      .limit(Number(limit) + 1)
      .offset(offset);

    const hasMore = jobs.length > limit;
    if (hasMore) jobs.pop();

    // Render template instead of returning JSON
    res.render("jobs", {
      jobs: jobs,
      hasMore: hasMore,
      currentPage: parseInt(page),
      filters: req.query,
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// admin only – optional ?q= filters by HR email, job name, or company name (includes job descriptions)
router.get("/adm", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    let query = db("jobs")
      .select(...JOBS_LIST_COLUMNS, "jobDescription")
      .orderBy("created_at", "desc");
    if (q) {
      const pattern = "%" + q.replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
      query = query.whereRaw(
        '"company_email" ILIKE ? OR "jobName" ILIKE ? OR "companyName" ILIKE ?',
        [pattern, pattern, pattern],
      );
    }
    const rows = await query;
    const jobIds = rows.map((r) => r.id);
    if (jobIds.length === 0) {
      return res.json({
        data: rows.map((j) => ({
          ...j,
          cv_stats: { tried: 0, succeeded: 0, failed: 0 },
          cv_accepted: [],
          cv_refused: [],
        })),
      });
    }
    const [succeededByJob, failedByJob, acceptedRows, refusedRows] =
      await Promise.all([
        db("job_applications")
          .select("job_id")
          .count("id as n")
          .whereIn("job_id", jobIds)
          .groupBy("job_id"),
        db("cv_refusals")
          .select("job_id")
          .count("id as n")
          .whereIn("job_id", jobIds)
          .groupBy("job_id"),
        db("job_applications as ja")
          .join("users as u", "u.user_uid", "ja.user_id")
          .leftJoin(
            db.raw(
              "(SELECT DISTINCT ON (user_id) user_id, file_url FROM resumes ORDER BY user_id, updated_at DESC NULLS LAST) as r",
            ),
            "r.user_id",
            "ja.user_id",
          )
          .whereIn("ja.job_id", jobIds)
          .select(
            "ja.job_id",
            "ja.user_id",
            "ja.created_at",
            "u.user_name",
            "u.user_email",
            "r.file_url as cv_url",
          ),
        db("cv_refusals as cr")
          .join("users as u", "u.user_uid", "cr.user_id")
          .leftJoin(
            db.raw(
              "(SELECT DISTINCT ON (user_id) user_id, file_url FROM resumes ORDER BY user_id, updated_at DESC NULLS LAST) as r",
            ),
            "r.user_id",
            "cr.user_id",
          )
          .whereIn("cr.job_id", jobIds)
          .select(
            "cr.job_id",
            "cr.user_id",
            "cr.created_at",
            "cr.complaint_sent",
            "u.user_name",
            "u.user_email",
            "r.file_url as cv_url",
          ),
      ]);
    const succeededMap = new Map(
      succeededByJob.map((r) => [r.job_id, parseInt(r.n || 0, 10)]),
    );
    const failedMap = new Map(
      failedByJob.map((r) => [r.job_id, parseInt(r.n || 0, 10)]),
    );
    const acceptedByJob = new Map();
    for (const r of acceptedRows) {
      if (!acceptedByJob.has(r.job_id)) acceptedByJob.set(r.job_id, []);
      acceptedByJob.get(r.job_id).push({
        user_id: r.user_id,
        user_name: r.user_name || "N/A",
        user_email: r.user_email || "N/A",
        created_at: r.created_at,
        cv_url: r.cv_url || null,
      });
    }
    const refusedByJob = new Map();
    for (const r of refusedRows) {
      if (!refusedByJob.has(r.job_id)) refusedByJob.set(r.job_id, []);
      refusedByJob.get(r.job_id).push({
        user_id: r.user_id,
        user_name: r.user_name || "N/A",
        user_email: r.user_email || "N/A",
        created_at: r.created_at,
        complaint_sent: !!r.complaint_sent,
        cv_url: r.cv_url || null,
      });
    }
    const data = rows.map((job) => {
      const succeeded = succeededMap.get(job.id) || 0;
      const failed = failedMap.get(job.id) || 0;
      return {
        ...job,
        cv_stats: { tried: succeeded + failed, succeeded, failed },
        cv_accepted: acceptedByJob.get(job.id) || [],
        cv_refused: refusedByJob.get(job.id) || [],
      };
    });
    res.json({ data });
  } catch (err) {
    console.error("jobs adm error:", err);
    res.status(500).json({ error: err.message });
  }
});

// search jobs
router.get("/search", (req, res) => {
  const searchTerm = req.query.q;

  if (!searchTerm) {
    return res.status(400).send("Search term is required");
  }

  db("jobs")
    .where("jobName", "like", `%${searchTerm}%`)
    .then((rows) => res.json(rows))
    .catch((err) => res.status(500).send("Error querying database"));
});

// get all jobs for particular company
router.get("/company/:id", (req, res) => {
  db("jobs")
    .where("user_uid", req.params.id)
    .then((rows) => res.json(rows))
    .catch((err) => res.status(500).json({ error: err.message }));
});

// search qury save
router.post("/searchquery", (req, res) => {
  const { searchTerm } = req.body;
  if (!searchTerm) {
    return res.status(400).json({ error: "Search term is required" });
  }
  db("searchterms")
    .where({ searchTerm })
    .first()
    .then((existingTerm) => {
      if (existingTerm) {
        // If the search term exists, increment its count
        return db("searchterms")
          .where({ searchTerm })
          .increment("count", 1)
          .then(() =>
            res.status(200).json({ message: "Search term count incremented" }),
          );
      } else {
        // If the search term doesn't exist, insert it
        return db("searchterms")
          .insert({ searchTerm, count: 1 })
          .then(() => res.status(200).json({ message: "Search term saved" }));
      }
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

router.get("/searchterms", (req, res) => {
  db("searchterms")
    .select("*")
    .then((rows) => res.json(rows))
    .catch((err) => res.status(500).json({ error: err.message }));
});

/** Extract meaningful tokens (3+ chars) from text for overlap matching. */
function tokensForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u10A0-\u10FF\s]/gi, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/** Check if no_cv row matches job by metadata (categories, other_specify, short_description vs job). */
function noCvMatchesJob(noCvRow, jobText, jobTokens) {
  const candText = [
    noCvRow.categories,
    noCvRow.other_specify,
    noCvRow.short_description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const candTokens = new Set(tokensForMatch(candText));
  if (candTokens.size === 0) return false;
  // Match if any job token appears in candidate text, or any candidate token in job text
  for (const t of jobTokens) {
    if (t.length >= 2 && candText.includes(t)) return true;
  }
  for (const t of candTokens) {
    if (t.length >= 2 && jobText.includes(t)) return true;
  }
  return false;
}

// Phase 3: Top candidate matches for a job (Pinecone semantic search + no_cv metadata match)
router.get("/:id/top-candidates", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const topK = Math.min(
      100,
      Math.max(1, parseInt(req.query.topK, 10) || 100),
    ); // Default 100, max 100
    // Default 0.5: CV-job reranker scores rarely reach 0.9; 0.5–0.7 = decent match. Use minScore=0.7+ for stricter.
    const minScore = parseFloat(req.query.minScore);
    const effectiveMinScore = Number.isFinite(minScore) ? minScore : 0.5;
    if (isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }
    const job = await db("jobs").where("id", jobId).first();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    const catRow = job.category_id
      ? await db("categories")
          .where("id", job.category_id)
          .select("name")
          .first()
      : null;
    const jobText = [
      job.jobName || "",
      job.jobDescription || job.job_description || "",
      (catRow && catRow.name) || "",
    ]
      .join(" ")
      .toLowerCase();
    const jobTokens = tokensForMatch(jobText);

    const {
      getTopCandidatesForJob,
      getCandidateScoreForJob,
    } = require("../services/pineconeCandidates");
    const requireRoleMatch =
      String(req.query.requireRoleMatch || "")
        .trim()
        .toLowerCase() === "1" ||
      String(req.query.requireRoleMatch || "")
        .trim()
        .toLowerCase() === "true";
    // Pass job metadata (job_role, job_experience, etc.) for metadata-enriched search + reranking
    const matches = await getTopCandidatesForJob(
      {
        job_role: job.jobName || "",
        job_experience: job.job_experience || "",
        job_type: job.job_type || "",
        job_city: job.job_city || "",
        jobDescription: job.jobDescription || job.job_description || "",
        requireRoleMatch,
      },
      topK,
    );
    // Only return candidates that pass the score threshold
    let qualifiedMatches = matches.filter(
      (m) => (m.score || 0) >= effectiveMinScore,
    );
    const existingIds = new Set(qualifiedMatches.map((m) => m.id));

    // Add no_cv that match by metadata; use real vector score from Pinecone (respects minScore)
    const noCvRows = await db("user_without_cv").select("*");
    const metadataMatchedNoCv = [];
    for (const row of noCvRows) {
      const pid = `no_cv_${row.id}`;
      if (existingIds.has(pid)) continue;
      if (!noCvMatchesJob(row, jobText, jobTokens)) continue;
      const score = await getCandidateScoreForJob(job, pid);
      if (score == null || score < effectiveMinScore) continue;
      metadataMatchedNoCv.push({
        id: pid,
        score,
        metadata: {
          name: row.name,
          email: row.email || undefined,
          phone: row.phone,
          short_description: row.short_description || undefined,
          categories: row.categories || undefined,
          other_specify: row.other_specify || undefined,
        },
      });
      existingIds.add(pid);
    }
    qualifiedMatches = [...qualifiedMatches, ...metadataMatchedNoCv].slice(
      0,
      topK,
    );

    const userIds = qualifiedMatches.map((m) => m.id).filter(Boolean);
    if (userIds.length === 0) {
      return res.json({ job_id: jobId, candidates: [] });
    }
    const realUserIds = userIds.filter(
      (id) => !String(id).startsWith("no_cv_"),
    );
    const users = await db("users")
      .whereIn("user_uid", realUserIds)
      .select("user_uid", "user_name", "user_email");
    const userMap = Object.fromEntries(users.map((u) => [u.user_uid, u]));

    const resumeRows = await db("resumes")
      .whereIn("user_id", realUserIds)
      .orderBy("updated_at", "desc")
      .select("user_id", "file_url", "file_name");
    const resumeMap = {};
    resumeRows.forEach((r) => {
      if (!resumeMap[r.user_id]) resumeMap[r.user_id] = r;
    });

    // Last visit info per user: aggregate from visitors table
    const lastSeenRows = await db("visitors")
      .whereIn("user_id", realUserIds)
      .select("user_id")
      .groupBy("user_id")
      .max("last_seen as last_seen");
    const lastSeenMap = {};
    lastSeenRows.forEach((row) => {
      lastSeenMap[row.user_id] = row.last_seen;
    });

    const noCvIds = qualifiedMatches
      .filter((m) => String(m.id).startsWith("no_cv_"))
      .map((m) => parseInt(String(m.id).replace("no_cv_", ""), 10))
      .filter((n) => !isNaN(n) && n > 0);
    const noCvDescRows = noCvIds.length
      ? await db("user_without_cv")
          .whereIn("id", noCvIds)
          .select("id", "ai_description")
      : [];
    const noCvAiDescMap = Object.fromEntries(
      noCvDescRows.map((r) => [`no_cv_${r.id}`, r.ai_description]),
    );

    const candidates = qualifiedMatches.map((m) => {
      const isNoCv = String(m.id).startsWith("no_cv_");
      if (isNoCv) {
        const meta = m.metadata || {};
        return {
          user_id: m.id,
          score: m.score,
          user_name: meta.name || null,
          user_email: meta.email || null,
          cv_url: null,
          cv_file_name: null,
          last_seen_at: null,
          no_cv: true,
          phone: meta.phone || null,
          short_description: meta.short_description || null,
          categories: meta.categories || null,
          ai_description: noCvAiDescMap[m.id] || null,
        };
      }
      const u = userMap[m.id];
      const r = resumeMap[m.id];
      return {
        user_id: m.id,
        score: m.score,
        user_name: u?.user_name || null,
        user_email: u?.user_email || null,
        cv_url: r?.file_url || null,
        cv_file_name: r?.file_name || null,
        last_seen_at: lastSeenMap[m.id] || null,
      };
    });

    // Optional: Gemini alignment assessment (assessWithGemini=1&assessLimit=10)
    const assessWithGemini =
      String(req.query.assessWithGemini || "")
        .trim()
        .toLowerCase() === "1" ||
      String(req.query.assessWithGemini || "")
        .trim()
        .toLowerCase() === "true";
    const assessLimit = Math.min(
      20,
      Math.max(1, parseInt(req.query.assessLimit, 10) || 10),
    );

    if (assessWithGemini && candidates.length > 0) {
      const {
        assessCandidateAlignment,
        assessNoCvAlignment,
      } = require("../services/geminiCandidateAssessment");
      const { extractTextFromCv } = require("../services/cvTextExtractor");

      const cvCandidates = candidates.filter((c) => c.cv_url);
      const noCvCandidates = candidates.filter((c) => c.no_cv);
      const toAssessCv = cvCandidates.slice(0, assessLimit);

      const noCvFullRows =
        noCvIds.length > 0
          ? await db("user_without_cv")
              .whereIn("id", noCvIds)
              .select("id", "name", "short_description", "categories", "other_specify")
          : [];
      const noCvRowMap = Object.fromEntries(
        noCvFullRows.map((r) => [r.id, r]),
      );

      const assessCvOne = async (c) => {
        try {
          const cvText = await extractTextFromCv(c.cv_url, c.cv_file_name);
          if (!cvText || cvText.length < 50) {
            return {
              ...c,
              gemini_assessment: { error: "Could not extract CV text" },
            };
          }
          const assessment = await assessCandidateAlignment(job, cvText);
          return { ...c, gemini_assessment: assessment };
        } catch (err) {
          return {
            ...c,
            gemini_assessment: { error: err.message || "Assessment failed" },
          };
        }
      };

      const assessNoCvOne = async (c) => {
        const nid = parseInt(String(c.user_id).replace("no_cv_", ""), 10);
        const row = noCvRowMap[nid];
        if (!row) {
          return { ...c, gemini_assessment: { error: "No-CV row not found" } };
        }
        try {
          const assessment = await assessNoCvAlignment(job, row);
          return {
            ...c,
            ai_description: assessment.summary,
            gemini_assessment: assessment,
          };
        } catch (err) {
          return {
            ...c,
            gemini_assessment: { error: err.message || "Assessment failed" },
          };
        }
      };

      const [assessedCv, assessedNoCv] = await Promise.all([
        Promise.all(toAssessCv.map(assessCvOne)),
        Promise.all(noCvCandidates.slice(0, assessLimit).map(assessNoCvOne)),
      ]);

      const assessedMap = {};
      assessedCv.forEach((a) => { assessedMap[a.user_id] = a; });
      assessedNoCv.forEach((a) => { assessedMap[a.user_id] = a; });

      const result = candidates.map((c) => assessedMap[c.user_id] || c);
      return res.json({ job_id: jobId, candidates: result });
    }

    res.json({ job_id: jobId, candidates });
  } catch (err) {
    console.error("jobs top-candidates error:", err);
    res
      .status(500)
      .json({ error: err.message || "Failed to get top candidates" });
  }
});

// CV attempt stats for a job: how many tried, how many failed (Gemini NOT_FIT)
router.get("/:id/cv-stats", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }
    const job = await db("jobs").where("id", jobId).first();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    const [succeeded, failed] = await Promise.all([
      db("job_applications").where("job_id", jobId).count("id as n").first(),
      db("cv_refusals").where("job_id", jobId).count("id as n").first(),
    ]);
    const succeededCount = parseInt(succeeded?.n || 0, 10);
    const failedCount = parseInt(failed?.n || 0, 10);
    res.json({
      job_id: jobId,
      tried: succeededCount + failedCount,
      succeeded: succeededCount,
      failed: failedCount,
      cvs_sent: job.cvs_sent || 0,
    });
  } catch (err) {
    console.error("jobs cv-stats error:", err);
    res.status(500).json({ error: err.message });
  }
});

// get a specific job by ID (includes cv_stats, cv_accepted, cv_refused)
router.get("/:id", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid job ID" });
    }
    const job = await db("jobs").where("id", jobId).first();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    const [acceptedRows, refusedRows, formSubmissions] = await Promise.all([
      db("job_applications as ja")
        .join("users as u", "u.user_uid", "ja.user_id")
        .leftJoin(
          db.raw(
            "(SELECT DISTINCT ON (user_id) user_id, file_url FROM resumes ORDER BY user_id, updated_at DESC NULLS LAST) as r",
          ),
          "r.user_id",
          "ja.user_id",
        )
        .where("ja.job_id", jobId)
        .select(
          "ja.user_id",
          "ja.created_at",
          "u.user_name",
          "u.user_email",
          "r.file_url as cv_url",
        )
        .orderBy("ja.created_at", "desc"),
      db("cv_refusals as cr")
        .join("users as u", "u.user_uid", "cr.user_id")
        .leftJoin(
          db.raw(
            "(SELECT DISTINCT ON (user_id) user_id, file_url FROM resumes ORDER BY user_id, updated_at DESC NULLS LAST) as r",
          ),
          "r.user_id",
          "cr.user_id",
        )
        .where("cr.job_id", jobId)
        .select(
          "cr.user_id",
          "cr.created_at",
          "cr.complaint_sent",
          "u.user_name",
          "u.user_email",
          "r.file_url as cv_url",
        )
        .orderBy("cr.created_at", "desc"),
      db("job_form_submissions")
        .where("job_id", jobId)
        .select("*")
        .orderBy("created_at", "desc"),
    ]);
    const cv_accepted = acceptedRows.map((r) => ({
      user_id: r.user_id,
      user_name: r.user_name || "N/A",
      user_email: r.user_email || "N/A",
      created_at: r.created_at,
      cv_url: r.cv_url || null,
    }));
    const cv_refused = refusedRows.map((r) => ({
      user_id: r.user_id,
      user_name: r.user_name || "N/A",
      user_email: r.user_email || "N/A",
      created_at: r.created_at,
      complaint_sent: !!r.complaint_sent,
      cv_url: r.cv_url || null,
    }));
    res.json({
      ...job,
      cv_stats: {
        tried: cv_accepted.length + cv_refused.length,
        succeeded: cv_accepted.length,
        failed: cv_refused.length,
      },
      cv_accepted,
      cv_refused,
      form_submissions: formSubmissions || [],
    });
  } catch (err) {
    console.error("jobs get :id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Remove a user from job applications (admin)
router.delete("/:id/applications/:userId", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const userId = req.params.userId;
    if (isNaN(jobId) || !userId) {
      return res.status(400).json({ error: "Invalid job ID or user ID" });
    }
    const job = await db("jobs").where("id", jobId).first();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    const deleted = await db("job_applications")
      .where({ job_id: jobId, user_id: userId })
      .del();
    if (deleted > 0) {
      const cvsSent = Math.max(0, (job.cvs_sent || 0) - 1);
      await db("jobs").where("id", jobId).update({ cvs_sent: cvsSent });
    }
    res.json({
      removed: deleted > 0,
      message: deleted > 0 ? "Application removed" : "Application not found",
    });
  } catch (err) {
    console.error("jobs remove application error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Remove a user from cv_refusals (admin) - allows them to try again
router.delete("/:id/refusals/:userId", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const userId = req.params.userId;
    if (isNaN(jobId) || !userId) {
      return res.status(400).json({ error: "Invalid job ID or user ID" });
    }
    const job = await db("jobs").where("id", jobId).first();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    const deleted = await db("cv_refusals")
      .where({ job_id: jobId, user_id: userId })
      .del();
    res.json({
      removed: deleted > 0,
      message:
        deleted > 0
          ? "Refusal removed - user can try again"
          : "Refusal not found",
    });
  } catch (err) {
    console.error("jobs remove refusal error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Reset complaint_sent for a refused user (admin) - allows them to send complaint again
router.post("/:id/refusals/:userId/reset-complaint", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const userId = req.params.userId;
    if (isNaN(jobId) || !userId) {
      return res.status(400).json({ error: "Invalid job ID or user ID" });
    }
    const updated = await db("cv_refusals")
      .where({ job_id: jobId, user_id: userId })
      .update({ complaint_sent: false });
    res.json({
      updated: updated > 0,
      message:
        updated > 0
          ? "Complaint reset - user can complain again"
          : "Refusal not found",
    });
  } catch (err) {
    console.error("jobs reset complaint error:", err);
    res.status(500).json({ error: err.message });
  }
});

// create a new job (company_logo is a string URL from admin, not a file upload)
const upload = multer();

router.post("/", upload.none(), async (req, res) => {
  const {
    companyName,
    jobName,
    jobSalary,
    jobDescription,
    jobIsUrgent,
    user_uid,
    category_id,
    company_email,
    company_logo,
    job_experience,
    job_city,
    job_address,
    job_type,
    job_premium_status,
    isHelio,
    helio_url,
    prioritize,
    dont_send_email,
  } = req.body;

  if (
    !companyName ||
    !jobName ||
    !jobDescription ||
    jobIsUrgent === undefined ||
    !user_uid ||
    !company_email ||
    !category_id
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const jName = String(jobName || "").trim();
  const cName = String(companyName || "").trim();

  if (await isBlacklisted(company_email, cName)) {
    return res.status(403).json({
      error: "Blacklisted company",
      message: "This company cannot upload vacancies",
    });
  }

  const existing = await db("jobs")
    .where("job_status", "approved")
    .where("jobName", jName)
    .where("companyName", cName)
    .first();

  if (existing) {
    return res.status(409).json({
      error: "Duplicate job",
      message: "A job with this title and company already exists",
      existingId: existing.id,
    });
  }

  try {
    const [inserted] = await db("jobs")
      .insert({
        companyName: cName,
        jobName: jName,
        jobSalary,
        jobDescription,
        jobIsUrgent,
        user_uid,
        category_id,
        company_email,
        company_logo: company_logo || null,
        job_experience,
        job_city,
        job_address,
        job_type,
        job_premium_status,
        isHelio,
        helio_url: (helio_url && String(helio_url).trim()) || null,
        prioritize: prioritize === true || prioritize === "true",
        dont_send_email: dont_send_email === true || dont_send_email === "true",
        job_status: "approved",
      })
      .returning("id");

    if (inserted) {
      const fullJob = await db("jobs")
        .where("id", inserted.id)
        .select("*")
        .first();
      if (fullJob && !fullJob.dont_send_email && fullJob.company_email) {
        const evalResult = await evaluateJobForNewJobEmail(fullJob).catch(
          (e) => {
            console.error(
              "[evaluateJob] Failed for job",
              fullJob.id,
              ":",
              e.message,
            );
            return { shouldQueue: false, reason: e.message };
          },
        );
        if (evalResult.shouldQueue && evalResult.bestCandidate) {
          await sendNewJobEmail(
            {
              id: fullJob.id,
              jobName: fullJob.jobName,
              companyName: fullJob.companyName,
              company_email: fullJob.company_email,
              jobSalary: fullJob.jobSalary,
              dont_send_email: fullJob.dont_send_email,
            },
            { bestCandidate: evalResult.bestCandidate, matchType: evalResult.matchType },
          );
        }
      }
      // Index job in Pinecone for "jobs for user" recommendations
      upsertJob(inserted.id, {
        jobName: jName,
        jobDescription,
        job_experience,
        job_city,
        job_type,
      }).catch((err) =>
        console.error("[pinecone] Failed to index job:", err.message),
      );
      invalidateFilterCountsCache();
    }

    res.status(201).json({ message: "Job created", jobId: inserted?.id });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        error: "Duplicate job",
        message: "A job with this title and company already exists",
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// bulk upload many jobs
router.post("/bulk", async (req, res) => {
  const jobsToInsert = req.body;

  if (!Array.isArray(jobsToInsert)) {
    console.error("❌ REJECTED: Payload is not an array.");
    return res.status(400).json({ error: "Payload must be an array" });
  }

  const validJobs = [];
  const failedJobs = [];
  const seenInBatch = new Set();

  for (let index = 0; index < jobsToInsert.length; index++) {
    const job = jobsToInsert[index];
    const hasRequiredFields =
      job.companyName && job.jobName && job.user_uid && job.category_id;

    if (hasRequiredFields) {
      const jName = String(job.jobName || "").trim();
      const cName = String(job.companyName || "").trim();
      const key = jName + "|" + cName;

      if (seenInBatch.has(key)) {
        failedJobs.push({
          index,
          jobName: jName,
          error: "Duplicate within batch",
        });
        continue;
      }
      if (await isBlacklisted(job.company_email, job.companyName)) {
        failedJobs.push({
          index,
          jobName: jName,
          error: "Blacklisted company",
        });
        continue;
      }
      seenInBatch.add(key);

      validJobs.push({
        companyName: cName,
        jobName: jName,
        jobSalary: job.jobSalary,
        jobDescription: job.jobDescription,
        jobIsUrgent: job.jobIsUrgent || false,
        user_uid: job.user_uid,
        category_id: job.category_id,
        company_email: job.company_email,
        job_experience: job.job_experience,
        job_city: job.job_city,
        job_address: job.job_address,
        job_type: job.job_type,
        job_status: "approved",
        job_premium_status: "regular",
        isHelio: job.isHelio || false,
        helio_url: (job.helio_url && String(job.helio_url).trim()) || null,
        prioritize: job.prioritize === true || job.prioritize === "true",
        dont_send_email:
          job.dont_send_email === true || job.dont_send_email === "true",
        company_logo: job.company_logo || null,
      });
    } else {
      console.error(`⚠️ JOB FAILED VALIDATION (Index: ${index}):`, {
        jobName: job.jobName || "UNKNOWN",
        company: job.companyName || "UNKNOWN",
        reason:
          "Missing required fields (companyName, jobName, user_uid, or category_id)",
      });
      failedJobs.push({
        index,
        jobName: job.jobName || "Unknown",
        error: "Missing required fields",
      });
    }
  }

  // If everything failed validation, stop here
  if (validJobs.length === 0) {
    return res.status(400).json({
      error: "No valid jobs to insert",
      failedCount: failedJobs.length,
    });
  }

  try {
    const existingRows = await db("jobs")
      .select("jobName", "companyName")
      .where("job_status", "approved");
    const existingSet = new Set(
      existingRows.map(
        (r) =>
          String(r.jobName || "").trim() +
          "|" +
          String(r.companyName || "").trim(),
      ),
    );

    const toInsert = validJobs.filter(
      (j) => !existingSet.has(j.jobName + "|" + j.companyName),
    );
    const skippedAsDuplicates = validJobs.length - toInsert.length;

    if (skippedAsDuplicates > 0) {
      console.warn(
        `[!] Skipped ${skippedAsDuplicates} jobs – duplicate of existing approved job`,
      );
    }

    if (toInsert.length === 0) {
      return res.status(400).json({
        error: "All jobs are duplicates of existing approved jobs",
        failedCount: failedJobs.length,
        skippedCount: skippedAsDuplicates,
      });
    }

    const ids = await db("jobs").insert(toInsert).returning("id");

    // Index each new job in Pinecone for "jobs for user" recommendations
    const insertedJobs = toInsert.map((j, i) => ({
      ...j,
      id: ids[i]?.id ?? ids[i],
    }));
    for (const j of insertedJobs) {
      upsertJob(j.id, {
        jobName: j.jobName,
        jobDescription: j.jobDescription,
        job_experience: j.job_experience,
        job_city: j.job_city,
        job_type: j.job_type,
      }).catch((err) =>
        console.error("[pinecone] Failed to index job:", err.message),
      );
    }

    // Send one email per company (group by company_email to avoid duplicates when company uploads multiple jobs)
    const jobsWithIds = toInsert
      .map((j, i) => ({ ...j, id: ids[i]?.id ?? ids[i] }))
      .filter((j) => !j.dont_send_email && (j.company_email || "").trim());
    const byCompany = new Map();
    for (const j of jobsWithIds) {
      const key = (j.company_email || "").trim().toLowerCase();
      if (!byCompany.has(key)) byCompany.set(key, []);
      byCompany.get(key).push(j);
    }
    const companies = Array.from(byCompany.values());
    const emailStats = {
      queued: 0,
      skippedNoEmail: toInsert.length - jobsWithIds.length,
      skipped: {},
    };
    for (let i = 0; i < companies.length; i++) {
      const result = await sendNewJobEmailToCompany(
        companies[i],
        i,
        companies.length,
      );
      if (result.queued) {
        emailStats.queued++;
      } else {
        const r = result.reason || "unknown";
        emailStats.skipped[r] = (emailStats.skipped[r] || 0) + 1;
      }
    }

    console.log(
      `✅ SUCCESS: Inserted ${ids.length} jobs. Emails: ${emailStats.queued} queued, ${companies.length - emailStats.queued} skipped.`,
    );
    if (failedJobs.length > 0) {
      console.warn(
        `[!] Note: ${failedJobs.length} jobs were skipped due to errors.`,
      );
    }

    invalidateFilterCountsCache();

    res.status(201).json({
      message:
        "Jobs inserted. Emails will be sent over the next 2-3 hours (see emailQueue).",
      insertedCount: ids.length,
      failedCount: failedJobs.length,
      skippedAsDuplicates,
      failedJobs: failedJobs,
      emailQueue: {
        companiesWithEmail: companies.length,
        queued: emailStats.queued,
        skippedNoEmail: emailStats.skippedNoEmail,
        skipped: emailStats.skipped,
        pending: await getQueueCount(),
      },
    });
  } catch (err) {
    // This catches DB-level crashes (e.g. unique constraint violations)
    console.error("🔥 DATABASE CRITICAL ERROR:", err.message);
    res
      .status(500)
      .json({ error: "Database rejected the batch", details: err.message });
  }
});

// PATCH route to update a job
const JOB_UPDATE_WHITELIST = [
  "companyName",
  "user_uid",
  "company_email",
  "jobName",
  "jobSalary",
  "jobDescription",
  "job_experience",
  "job_city",
  "job_address",
  "job_type",
  "jobIsUrgent",
  "category_id",
  "job_premium_status",
  "premium_until",
  "isHelio",
  "helio_url",
  "job_status",
  "cvs_sent",
  "company_logo",
  "jobSalary_min",
  "view_count",
  "expires_at",
  "prioritize",
  "dont_send_email",
  "marketing_email_sent",
  "cv_submissions_email_sent",
  "disable_cv_filter",
  "accept_form_submissions",
  "updated_at",
];
// Admin apps often send camelCase; map to DB column names
const CAMEL_TO_SNAKE = {
  acceptFormSubmissions: "accept_form_submissions",
  disableCvFilter: "disable_cv_filter",
  premiumUntil: "premium_until",
  helioUrl: "helio_url",
};

const patchOrPutJob = async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (!jobId || isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid job id" });
    }
    const body = req.body;

    console.log(
      "[PATCH/PUT jobs] jobId=" +
        jobId +
        " body keys=" +
        Object.keys(body).join(",") +
        " accept_form_submissions=" +
        JSON.stringify(
          body.accept_form_submissions ?? body.acceptFormSubmissions,
        ),
    );

    const updateData = {};
    const booleanFields = new Set([
      "accept_form_submissions",
      "disable_cv_filter",
      "isHelio",
      "jobIsUrgent",
      "prioritize",
      "dont_send_email",
      "marketing_email_sent",
      "cv_submissions_email_sent",
    ]);
    for (const key of Object.keys(body)) {
      const dbKey = CAMEL_TO_SNAKE[key] || key;
      if (JOB_UPDATE_WHITELIST.includes(dbKey) && body[key] !== undefined) {
        let val = body[key];
        if (dbKey === "premium_until") {
          val = parsePremiumUntil(val);
          if (val === null && body[key] !== "" && body[key] !== undefined)
            continue; // invalid, skip
        } else if (booleanFields.has(dbKey)) {
          val =
            val === true ||
            val === 1 ||
            val === "true" ||
            val === "1" ||
            val === "on";
        }
        updateData[dbKey] = val;
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No fields provided to update" });
    }

    // Force accept_form_submissions via raw SQL (bypasses any Knex/pg serialization quirks)
    if (updateData.accept_form_submissions !== undefined) {
      const boolVal = !!updateData.accept_form_submissions;
      const rawResult = await db.raw(
        "UPDATE jobs SET accept_form_submissions = ? WHERE id = ?",
        [boolVal, jobId],
      );
      const rowCount = rawResult.rowCount ?? rawResult[1] ?? 0;
      if (rowCount === 0) {
        return res.status(404).json({ error: "Job not found" });
      }
      delete updateData.accept_form_submissions;
      const cache = req.app.locals.pageCache;
      if (cache) {
        const job = await db("jobs").where("id", jobId).select("jobName").first();
        if (job) cache.del(`/vakansia/${slugify(job.jobName)}-${jobId}`);
      }
    }

    if (Object.keys(updateData).length > 0) {
      const count = await db("jobs").where("id", jobId).update(updateData);
      if (count === 0) {
        return res.status(404).json({ error: "Job not found" });
      }
      // Re-index or remove from Pinecone when job content/expiry changes
      const pineconeFields = [
        "jobName",
        "jobDescription",
        "job_experience",
        "job_type",
        "job_city",
        "expires_at",
      ];
      const touchedPinecone = Object.keys(updateData).some((k) =>
        pineconeFields.includes(k),
      );
      if (touchedPinecone) {
        const job = await db("jobs")
          .where("id", jobId)
          .select(
            "jobName",
            "jobDescription",
            "job_experience",
            "job_type",
            "job_city",
            "expires_at",
          )
          .first();
        if (job) {
          if (job.expires_at && new Date(job.expires_at) <= new Date()) {
            deleteJob(jobId).catch((err) =>
              console.error("[pinecone] Failed to delete job:", err.message),
            );
          } else {
            upsertJob(jobId, {
              jobName: job.jobName,
              jobDescription: job.jobDescription || job.job_description,
              job_experience: job.job_experience,
              job_type: job.job_type,
              job_city: job.job_city,
            }).catch((err) =>
              console.error("[pinecone] Failed to re-index job:", err.message),
            );
          }
        }
      }
      const cache = req.app.locals.pageCache;
      if (cache) {
        const job = await db("jobs").where("id", jobId).select("jobName").first();
        if (job) cache.del(`/vakansia/${slugify(job.jobName)}-${jobId}`);
      }
      // Invalidate job description cache when jobDescription was updated
      if (updateData.jobDescription !== undefined) {
        const descCache = req.app.locals.jobDescCache;
        if (descCache) descCache.del(`desc_${jobId}`);
      }
    }

    res.status(200).json({ message: "Job updated successfully" });
  } catch (err) {
    console.error("[PATCH jobs] error:", err);
    res.status(500).json({ error: err.message });
  }
};

router.patch("/:id", patchOrPutJob);
router.put("/:id", patchOrPutJob);

// DELETE route to remove a job
router.delete("/:id", async (req, res) => {
  const jobId = parseInt(req.params.id, 10);
  if (!jobId || isNaN(jobId)) {
    return res.status(400).json({ error: "Invalid job id" });
  }

  try {
    const job = await db("jobs").where("id", jobId).select("jobName").first();
    const count = await db("jobs").where("id", jobId).del();
    if (count === 0) {
      return res.status(404).json({ error: "Job not found" });
    }
    const cache = req.app.locals.pageCache;
    if (cache && job) cache.del(`/vakansia/${slugify(job.jobName)}-${jobId}`);
    deleteJob(jobId).catch((err) =>
      console.error("[pinecone] Failed to delete job:", err.message),
    );
    res.status(200).json({ message: "Job deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.getEmailQueueStatus = async () => {
  const pending = await getQueueCount();
  return {
    pending,
    lastSentAt: newJobEmailLastSentAt || null,
    processorScheduled: newJobEmailProcessorScheduled,
  };
};

router.getEmailQueueDetails = async () => {
  try {
    // Raw counts from queue table (no join) so we see best_candidate_followup etc. even if join drops rows
    const queueCounts =
      await db("new_job_email_queue")
        .select("email_type")
        .count("id as n")
        .groupBy("email_type");
    const pendingByType = {};
    let queueTableTotal = 0;
    for (const row of queueCounts || []) {
      const type = row.email_type || "new_job";
      const n = parseInt(row.n || 0, 10);
      pendingByType[type] = n;
      queueTableTotal += n;
    }

    const hasBestCandidateId = await db.schema.hasColumn(
      "new_job_email_queue",
      "best_candidate_id",
    );
    // Pending = every row in new_job_email_queue. One row in table = one item in pending with status "queued". No filter.
    const pendingRows = await db("new_job_email_queue")
      .orderBy("send_after", "asc");
    const rows = Array.isArray(pendingRows) ? pendingRows : [];
    const jobIds = [...new Set(rows.map((r) => r.job_id).filter(Boolean))];
    const jobRows =
      jobIds.length > 0
        ? await db("jobs")
            .whereIn("id", jobIds)
            .select("id", "jobName", "companyName", "company_email")
        : [];
    const jobMap = Object.fromEntries((jobRows || []).map((j) => [j.id, j]));
    const bestCandidateIds =
      hasBestCandidateId ? rows.map((r) => r.best_candidate_id).filter(Boolean) : [];
    const realUserIds = bestCandidateIds.filter(
      (id) => !String(id).startsWith("no_cv_"),
    );
    const noCvIds = bestCandidateIds
      .filter((id) => String(id).startsWith("no_cv_"))
      .map((id) => parseInt(String(id).replace("no_cv_", ""), 10))
      .filter((n) => !isNaN(n) && n > 0);

    let bestCandidateMap = {};
    if (bestCandidateIds.length > 0) {
      const resumeRows =
        realUserIds.length > 0
          ? await db("resumes")
              .whereIn("user_id", realUserIds)
              .orderBy("updated_at", "desc")
              .select("user_id", "file_url", "file_name")
          : [];
      const resumeByUser = {};
      resumeRows.forEach((r) => {
        if (!resumeByUser[r.user_id]) resumeByUser[r.user_id] = r;
      });
      const userRows =
        realUserIds.length > 0
          ? await db("users")
              .whereIn("user_uid", realUserIds)
              .select("user_uid", "user_name", "user_email")
          : [];
      const userMap = Object.fromEntries(
        userRows.map((u) => [u.user_uid, u]),
      );
      const noCvRows =
        noCvIds.length > 0
          ? await db("user_without_cv")
              .whereIn("id", noCvIds)
              .select("id", "name", "email", "phone")
          : [];
      const noCvById = Object.fromEntries(
        noCvRows.map((r) => [`no_cv_${r.id}`, r]),
      );

      for (const id of bestCandidateIds) {
        if (String(id).startsWith("no_cv_")) {
          const row = noCvById[id];
          bestCandidateMap[id] = row
            ? {
                id,
                cv_url: null,
                cv_file_name: null,
                name: row.name,
                email: row.email || null,
                phone: row.phone || null,
              }
            : { id, cv_url: null, email: null, phone: null };
        } else {
          const r = resumeByUser[id];
          const u = userMap[id];
          bestCandidateMap[id] = {
            id,
            cv_url: r?.file_url || null,
            cv_file_name: r?.file_name || null,
            name: u?.user_name || null,
            email: u?.user_email || null,
            phone: null,
          };
        }
      }
    }

    const job = (id) => jobMap[id] || {};
    // Helper: ensure each queue item exposes candidate cv_url or phone/email for admin
    const candidateCvUrlOrContact = (bc) => {
      if (!bc) return null;
      if (bc.cv_url) return bc.cv_url;
      if (bc.phone) return `phone: ${bc.phone}`;
      if (bc.email) return `email: ${bc.email}`;
      return null;
    };
    const pending = rows.map((r) => {
      const item = {
        queue_id: r.id,
        job_id: r.job_id,
        email_type: r.email_type || "new_job",
        job_name: job(r.job_id).jobName ?? null,
        company_name: job(r.job_id).companyName ?? null,
        company_email: job(r.job_id).company_email ?? r.company_email_lower ?? null,
        send_after: r.send_after,
        status: "queued",
      };
      if (hasBestCandidateId && r.best_candidate_id) {
        const bc = bestCandidateMap[r.best_candidate_id] || null;
        item.best_candidate = bc;
        item.candidate_cv_url_or_contact = candidateCvUrlOrContact(bc);
      }
      return item;
    });

    const hasMarketingSent = await db.schema.hasColumn(
      "jobs",
      "marketing_email_sent",
    );
    const hasGeneralMarketingSent = await db.schema.hasColumn(
      "jobs",
      "general_marketing_email_sent",
    );
    const sentFlagCol = hasMarketingSent
      ? "marketing_email_sent"
      : hasGeneralMarketingSent
        ? "general_marketing_email_sent"
        : null;
    const sentRows = sentFlagCol
      ? await db.raw(
          `SELECT s.company_email_lower, s.sent_at, j.id as job_id, j.job_name, j.company_name
           FROM new_job_email_sent s
           LEFT JOIN LATERAL (
             SELECT id, "jobName" as job_name, "companyName" as company_name FROM jobs
             WHERE LOWER(company_email) = s.company_email_lower
             AND jobs.${sentFlagCol} = true
             LIMIT 1
           ) j ON true
           WHERE s.sent_at > now() - interval '7 days'
           ORDER BY s.sent_at DESC`,
        )
      : { rows: [] };
    const sentData = Array.isArray(sentRows) ? sentRows : sentRows?.rows || [];
    const sent = sentData.map((r) => ({
      job_id: r.job_id,
      job_name: r.job_name,
      company_name: r.company_name,
      company_email: r.company_email_lower,
      sent_at: r.sent_at,
      status: "sent",
    }));

    return {
      pending,
      sent,
      summary: {
        queued: pending.length,
        sent: sent.length,
        queue_table_total: queueTableTotal,
        pending_by_type: pendingByType,
      },
    };
  } catch (e) {
    if (e.code === "42P01")
      return {
        pending: [],
        sent: [],
        summary: { queued: 0, sent: 0, queue_table_total: 0, pending_by_type: {} },
      };
    throw e;
  }
};

router.kickEmailQueue = () => {
  newJobEmailProcessorScheduled = true;
  processNewJobEmailQueue();
};

router.getPremiumLowCvCandidatesData = async () => {
  const jobs = await db("jobs")
    .whereIn("job_premium_status", ["premium", "premiumPlus"])
    .where("job_status", "approved")
    .where((qb) => {
      qb.where("cvs_sent", 0)
        .orWhere("cvs_sent", 1)
        .orWhereNull("cvs_sent");
    })
    .select(
      "id",
      "jobName",
      "companyName",
      "company_email",
      "cvs_sent",
      "jobDescription",
      "job_experience",
      "job_type",
      "job_city",
    )
    .orderBy("cvs_sent", "asc")
    .orderBy("id", "asc");

  const results = [];
  for (const job of jobs) {
    const candidates = await getTopGoodCandidatesForJob(job, 4);
    const jobLink = `${SITE_BASE_URL}/vakansia/${slugify(job.jobName)}-${job.id}`;
    const usersList = candidates.map((c) => ({
      user_name: c.name,
      user_email: c.email,
      phone: c.phone,
      userSummary: c.ai_description,
      cv_url: c.cv_url,
    }));
    results.push({
      job: {
        ...job,
        job_link: jobLink,
        cvs_sent: job.cvs_sent || 0,
      },
      candidates,
      sendPayload: {
        hr_email: job.company_email,
        job_name: job.jobName,
        job_id: job.id,
        company_name: job.companyName,
        job_link: jobLink,
        users_list: usersList,
      },
    });
    // Log to server console for visibility
    console.log(
      `[premium-low-cv] Job #${job.id} ${job.jobName} @ ${job.companyName}: ${candidates.length} candidates`,
    );
    candidates.forEach((c, i) => {
      console.log(
        `  ${i + 1}. ${c.name || "—"} (${c.verdict}): ${(c.ai_description || "").slice(0, 80)}...`,
      );
    });
  }
  return { jobs: results };
};

// Blacklisted company emails (DB)
router.get("/blacklist", async (req, res) => {
  try {
    const rows = await db("blacklisted_company_emails")
      .select("id", "email", "company_name", "created_at", "note")
      .orderBy("email");
    res.json(rows);
  } catch (e) {
    if (e.code === "42P01") return res.json([]);
    console.error("blacklist GET error:", e);
    res.status(500).json({ error: e.message });
  }
});

router.post("/blacklist", async (req, res) => {
  try {
    const body = req.body?.email ? req.body : { email: req.body };
    const email = (body.email || "").trim().toLowerCase();
    const company_name = (body.company_name || "").trim() || null;
    if (!email) return res.status(400).json({ error: "email required" });
    const [row] = await db("blacklisted_company_emails")
      .insert({ email, company_name, note: body.note || null })
      .returning("*");
    await refreshBlacklistCache();
    res.status(201).json(row);
  } catch (e) {
    if (e.code === "23505")
      return res.status(409).json({ error: "Email already blacklisted" });
    console.error("blacklist POST error:", e);
    res.status(500).json({ error: e.message });
  }
});

router.delete("/blacklist/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email || "")
      .trim()
      .toLowerCase();
    if (!email) return res.status(400).json({ error: "email required" });
    const count = await db("blacklisted_company_emails")
      .where("email", email)
      .del();
    if (count === 0) return res.status(404).json({ error: "Not found" });
    await refreshBlacklistCache();
    res.json({ deleted: true });
  } catch (e) {
    console.error("blacklist DELETE error:", e);
    res.status(500).json({ error: e.message });
  }
});

router.requeueJobsByIds = async (jobIds) => {
  if (!Array.isArray(jobIds) || jobIds.length === 0) return { added: 0 };
  const ids = jobIds.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
  if (ids.length === 0) return { added: 0 };
  const jobs = await db("jobs")
    .select("*")
    .whereIn("id", ids)
    .where("job_status", "approved");
  let added = 0;
  for (const j of jobs) {
    if (j.dont_send_email || !j.company_email) continue;
    const evalResult = await evaluateJobForNewJobEmail(j).catch((e) => {
      console.error("[requeue] evaluateJob failed for job", j.id, ":", e.message);
      return { shouldQueue: false };
    });
    if (evalResult.shouldQueue && evalResult.bestCandidate) {
      const result = await sendNewJobEmail(
        {
          id: j.id,
          jobName: j.jobName,
          companyName: j.companyName,
          company_email: j.company_email,
          jobSalary: j.jobSalary,
          dont_send_email: j.dont_send_email === true || j.dont_send_email === 1,
        },
        { bestCandidate: evalResult.bestCandidate, matchType: evalResult.matchType },
      );
      if (result.queued) added++;
    }
  }
  return { added, pending: await getQueueCount() };
};

/**
 * Bulk best-candidate follow-up: sent emails last 7 days → jobs → vector + Gemini → queue
 * follow-ups spread over 5–6 hours. Same process as send-best-candidate-followup-emails.js.
 */
router.post("/bulk-best-candidate-followup", async (req, res) => {
  try {
    const dryRun = !!(req.body && (req.body.dryRun === true || req.body.dry_run === true));
    const { runBulkBestCandidateFollowupFromLast7Days } = require("../services/bulkBestCandidateFollowup");
    const result = await runBulkBestCandidateFollowupFromLast7Days(db, { dryRun });
    if (result.inserted > 0 || (dryRun && (result.wouldInsert || 0) > 0)) {
      triggerNewJobEmailQueue();
    }
    res.json({
      ok: true,
      dryRun,
      ...result,
      message: dryRun
        ? `Would queue ${result.wouldInsert ?? 0} follow-up(s) over ${result.spreadHours ?? 6}h.`
        : `Queued ${result.inserted} best-candidate follow-up(s). Spread over ${result.spreadHours ?? 6}h. Check /jobs/email-queue-details.`,
    });
  } catch (err) {
    console.error("bulk-best-candidate-followup error:", err);
    res.status(500).json({ error: err.message || "Bulk follow-up failed" });
  }
});

function triggerNewJobEmailQueue() {
  if (!newJobEmailProcessorScheduled) {
    newJobEmailProcessorScheduled = true;
    processNewJobEmailQueue();
  }
}

router.triggerNewJobEmailQueue = triggerNewJobEmailQueue;

module.exports = function (sharedDb) {
  db = sharedDb;
  initEmailQueue();
  return router;
};

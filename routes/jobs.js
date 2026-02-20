const cors = require("cors");
const express = require("express");
const knex = require("knex");
const nodemailer = require("nodemailer");
const path = require("path");
const router = express.Router();
router.use(cors()); // Ensure CORS is applied to this router
const multer = require("multer");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { slugify } = require("../utils/slugify");
const { upsertJob, deleteJob } = require("../services/pineconeJobs");
const { parsePremiumUntil } = require("../utils/parsePremiumUntil");

// Use the same environment-based Knex config as the main app
const knexConfig = require("../knexfile");
const environment = process.env.NODE_ENV || "development";
const db = knex(knexConfig[environment]);

// Email for freshly uploaded jobs (to HR)
const NEW_JOB_MAIL_USER = (process.env.PROPOSITIONAL_MAIL_USER || "").trim();
const NEW_JOB_MAIL_PASS = (process.env.PROPOSITIONAL_MAIL_PASS || "").trim().replace(/\s/g, "");
// Marketing email (3rd CV, from giorgi@samushao.ge)
const MARKETING_MAIL_USER = (process.env.APPLICANTS_MAIL_USER || process.env.MARKETING_MAIL_USER || "").trim();
const MARKETING_MAIL_PASS = (process.env.APPLICANTS_MAIL_PASS || process.env.MARKETING_MAIL_PASS || "").trim().replace(/\s/g, "");
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://samushao.ge";
const EMAIL_SIGNATURE = (process.env.EMAIL_SIGNATURE || "").trim();

let blacklistCache = { emails: new Set(), companyNames: new Set() };
let blacklistLoaded = false;

async function loadBlacklist() {
  try {
    const rows = await db("blacklisted_company_emails").select("email", "company_name");
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
  const email = (typeof jobOrEmail === "string" ? jobOrEmail : jobOrEmail?.company_email || "").trim().toLowerCase();
  const name = (companyName ?? (typeof jobOrEmail === "object" ? jobOrEmail?.companyName : ""))?.trim().toLowerCase() || "";
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
  const pts = new Intl.DateTimeFormat("en-US", { timeZone: TZ_GEORGIA, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  const hour = parseInt(pts.find((p) => p.type === "hour").value, 10);
  const minute = parseInt(pts.find((p) => p.type === "minute").value, 10);
  // Defer to next morning only when between 18:30 and 00:00 Georgia time
  return hour > 18 || (hour === 18 && minute >= 30);
}
/** Returns Date for next calendar day 10:00 Tbilisi, stored as UTC (10:00 Tbilisi = 06:00 UTC) */
function getNextDay1020Georgia() {
  const now = new Date();
  const opts = { timeZone: TZ_GEORGIA, year: "numeric", month: "2-digit", day: "2-digit" };
  const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(now);
  const y = parseInt(parts.find((p) => p.type === "year").value, 10);
  const m = parseInt(parts.find((p) => p.type === "month").value, 10);
  const d = parseInt(parts.find((p) => p.type === "day").value, 10);
  return new Date(Date.UTC(y, m - 1, d + 1, 6, 0, 0)); // 06:00 UTC = 10:00 Tbilisi
}
/** Returns Date for next calendar day 10:00 Tbilisi (06:00 UTC) */
function getNextDay0900Georgia() {
  const now = new Date();
  const opts = { timeZone: TZ_GEORGIA, year: "numeric", month: "2-digit", day: "2-digit" };
  const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(now);
  const y = parseInt(parts.find((p) => p.type === "year").value, 10);
  const m = parseInt(parts.find((p) => p.type === "month").value, 10);
  const d = parseInt(parts.find((p) => p.type === "day").value, 10);
  return new Date(Date.UTC(y, m - 1, d + 1, 6, 0, 0)); // 06:00 UTC = 10:00 Tbilisi
}

// Bulk emails spread over 2 hours
const BULK_SPREAD_MS = 2 * 60 * 60 * 1000;       // 2 hours total window
const MIN_DELAY_BETWEEN_SENDS_MS = 60 * 1000;     // at least 1 min between sends
const MAX_DELAY_BETWEEN_SENDS_MS = 5 * 60 * 1000; // random 1–5 min before next check
const RESCHEDULE_SLOT_MINUTES = 7;                 // 7 min between rescheduled emails (09:00, 09:07, 09:14…)

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
      [companyEmail]
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
const MAX_WAIT_BEFORE_RECHECK_MS = 60 * 1000;      // Wake every 1 min when all items deferred
const POLL_INTERVAL_MS = 60 * 1000;                 // Fallback: poll every 1 min no matter what

(async () => {
  const n = await getQueueCount();
  const transportOk = !!newJobTransporter;
  console.log(`[Email queue] Startup: ${n} items in queue, transporter: ${transportOk ? "configured" : "NOT CONFIGURED (set PROPOSITIONAL_MAIL_USER/PASS)"}`);
  if (n > 0) {
    newJobEmailProcessorScheduled = true;
    processNewJobEmailQueue();
    // Fallback: poll every minute so we always catch due items
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
    const debug = await db.raw("SELECT NOW() as db_now, (SELECT send_after FROM new_job_email_queue ORDER BY send_after LIMIT 1) as first_send_after").then((r) => r.rows?.[0]);
    if (debug) {
      console.log(`[Email queue] DB now: ${debug.db_now}, first send_after: ${debug.first_send_after}`);
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
        "j.jobName",
        "j.companyName",
        "j.company_email",
        "j.jobSalary",
        "j.jobSalary_min"
      )
      .whereRaw("q.send_after <= NOW()")
      .orderBy("q.send_after")
      .first();
    if (!row) {
      const nextRow = await db("new_job_email_queue").select("send_after").orderBy("send_after").first();
      if (nextRow) {
        const idealWait = new Date(nextRow.send_after).getTime() - Date.now();
        const waitMs = Math.min(
          Math.max(MIN_DELAY_BETWEEN_SENDS_MS, idealWait),
          MAX_WAIT_BEFORE_RECHECK_MS
        );
        console.log(`[Email queue] All ${count} items scheduled for later; recheck in ${Math.round(waitMs / 1000)}s`);
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
        .whereBetween("send_after", [next0900.toISOString(), windowEnd.toISOString()])
        .count("id as n")
        .first()
        .then((r) => parseInt(r?.n || 0, 10));
      const offsetMs = existingCount * RESCHEDULE_SLOT_MINUTES * 60 * 1000;
      const newSendAfter = new Date(next0900.getTime() + offsetMs);
      await db("new_job_email_queue").where("id", row.queue_id).update({
        send_after: db.raw("?::timestamptz", [newSendAfter.toISOString()]),
      });
      console.log(`[Email queue] Rescheduled job #${row.job_id} to next day ${new Date(newSendAfter).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ_GEORGIA })} (slot ${existingCount + 1}, was due after 18:30)`);
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
          const hasCvSubmissions = await db.schema.hasColumn("jobs", "cv_submissions_email_sent");
          if (hasCvSubmissions) {
            await db("jobs").where("id", row.job_id).update({ cv_submissions_email_sent: true });
          }
          console.log(`📧 Sent third-CV marketing email to ${companyEmail} (job #${row.job_id})`);
        }
        await db("new_job_email_queue").where("id", row.queue_id).del();
        newJobEmailLastSentAt = Date.now();
        const nextDelay = randomBetween(MIN_DELAY_BETWEEN_SENDS_MS, MAX_DELAY_BETWEEN_SENDS_MS);
        newJobEmailProcessorScheduled = true;
        setTimeout(processNewJobEmailQueue, nextDelay);
      });
      return;
    }

    if (companyEmail && (await hasRecentlySentToCompany(companyEmail))) {
      console.log(`[Email queue] Skip job #${row.job_id} → ${companyEmail}: already sent in last 7 days`);
      await db("new_job_email_queue").where("id", row.queue_id).del();
      processNewJobEmailQueue();
      return;
    }
    const claimed = companyEmail && (await claimAndSendToCompany(companyEmail));
    if (companyEmail && !claimed) {
      console.log(`[Email queue] Skip job #${row.job_id} → ${companyEmail}: claim failed (another process or rate limit)`);
      await db("new_job_email_queue").where("id", row.queue_id).del();
      processNewJobEmailQueue();
      return;
    }
    if (!newJobTransporter) {
      console.error("[Email queue] PROPOSITIONAL_MAIL_USER/PASS not set – NOT deleting queue item, will retry in 5 min. Set env vars to send emails.");
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
    const toEmail = (job.company_email || "").trim().split(/[,;]/)[0].trim() || companyEmail;
    const mailOptions = {
      from: NEW_JOB_MAIL_USER,
      to: toEmail || job.company_email?.trim(),
      subject: `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`,
      html: NEW_JOB_HTML_TEMPLATE({ ...job, jobLink }),
    };
    newJobTransporter.sendMail(mailOptions, async (err) => {
      if (err) {
        console.error("New job email error:", err);
      } else {
        await db("jobs").where("id", row.job_id).update({ marketing_email_sent: true });
        console.log(`📧 Sent new-job email to ${job.company_email?.trim()} (job #${job.id}: ${job.jobName})`);
      }
      await db("new_job_email_queue").where("id", row.queue_id).del();
      newJobEmailLastSentAt = Date.now();
      const nextDelay = randomBetween(MIN_DELAY_BETWEEN_SENDS_MS, MAX_DELAY_BETWEEN_SENDS_MS);
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

const NEW_JOB_HTML_TEMPLATE = (job) => {
  const salaryNum = parseSalaryNum(job.jobSalary ?? job.jobSalary_min);
  const salaryDisplay = job.jobSalary ? String(job.jobSalary).replace(/<[^>]*>/g, "") : "—";
  const salaryParagraph =
    salaryNum != null && salaryNum >= 1200
      ? "ვინაიდან თქვენი კომპანია იხდის " + salaryDisplay + " ლარს, გამოხმაურება ისედაც იქნება, და ამიტომ გთავაზობთ სტანდარტული პაკეტით სარგებლობას."
      : salaryNum != null && salaryNum < 1200
        ? "ვინაიდან თქვენი კომპანია იხდის " + salaryDisplay + " ლარს, გთავაზობთ პრემიუმ/პრემიუმ+ პაკეტით სარგებლობას, ასე ბევრი ადამიანი ნახავს ვაკანსიას და მაღალი შანსია რომ მეტი რელევანტური რეზიუმეები გამოიგზავნება."
        : "";

  const lowSalaryBonus =
    salaryNum != null && salaryNum < 1200
      ? "<p>რადგან ჯერ არ ვიცნობთ ერთმანეთს, გვინდა ჩვენი პლატფორმა გაგაცნოთ, და გთავაზობთ პრემიუმ+ განცხადებას 100 ლარად 250 ლარის ნაცვლად.</p>"
      : "";

  return `
<p>გამარჯობა!</p>
<p>გაცნობებთ, რომ თქვენი ვაკანსია რომელიც საჯაროდ ხელმისაწვდომია ინტერნეტში, გავაზიარეთ ჩვენს პლატფორმაზე ( samushao.ge ), თუ აღნიშული თქვენთვის მიუღებელია, გთხოვთ შეგვატყობინოთ და განცხადებას წავშლით.</p>
<p>თუ არ ხართ წინააღმდეგი, გთავაზობთ სრულიად უფასო 7 დღიან პრემიუმ სტატუსს თქვენი ვაკანსიისთვის, რადგან გამოსცადოთ ჩვენი პლატფორმა.</p>
<p>რითიც გამოვირჩევით ის არის, რომ ხელოვნური ინტელექტი აანალიზებს კანდიდატების რეზიუმეებს, და თუ კანდიდატი თქვენს ვაკანსიას არ შეესაბამება, საიტი რეზიუმეს არ გამოაგზავნინებს, ანუ უფრო კვალიფიციურ კანდიდატებს მიიღებთ.</p>
<p>დამიდასტურეთ მეილის მიღება და თქვენს ვაკანსიას პრემიუმ სტატუსს მივანიჭებთ.</p>
<p>პატივისცემით,</p>
<p>გიორგი</p>
`;
};

/**
 * Add job to queue with sendAfter time.
 * @param {object} job
 * @param {object} opts - { batchIndex, batchTotal } for bulk (spreads over 2-3h); omit for single job (sends soon)
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
      .where((qb) => qb.where("email_type", "new_job").orWhereNull("email_type"))
      .first();
    if (existingJob) return { queued: false, reason: "duplicate_job_in_queue" };
    const existingCompany = await db("new_job_email_queue")
      .where("company_email_lower", companyEmail)
      .where((qb) => qb.where("email_type", "new_job").orWhereNull("email_type"))
      .first();
    if (existingCompany) return { queued: false, reason: "company_already_in_queue" };
  } catch (e) {
    if (e.code === "42P01") { /* table doesn't exist yet */ }
    else throw e;
  }
  if (await hasRecentlySentToCompany(companyEmail)) {
    return { queued: false, reason: "already_sent_last_7_days" };
  }

  const now = Date.now();
  let sendAfterMs;
  if (opts.batchTotal != null && opts.batchTotal > 0 && opts.batchIndex != null) {
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
  await db("new_job_email_queue").insert({
    job_id: job.id,
    company_email_lower: companyEmail,
    send_after: db.raw("?::timestamptz", [sendAfter.toISOString()]),
  });
  if (!newJobEmailProcessorScheduled) {
    newJobEmailProcessorScheduled = true;
    processNewJobEmailQueue();
  }
  return { queued: true };
}

/**
 * Send one email per company when multiple jobs are uploaded (bulk).
 * Spreads all emails over 2 hours with random jitter.
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
  return sendNewJobEmail(first, { batchIndex, batchTotal });
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
      .select("*")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())");

    // Apply filters
    if (company) query.where("companyName", company);
    if (category)
      query.whereIn(
        "category_id",
        Array.isArray(category) ? category : [category]
      );
    if (job_experience)
      query.whereIn(
        "job_experience",
        Array.isArray(job_experience) ? job_experience : [job_experience]
      );
    if (job_city)
      query.whereIn(
        "job_city",
        Array.isArray(job_city) ? job_city : [job_city]
      );
    if (job_type)
      query.whereIn(
        "job_type",
        Array.isArray(job_type) ? job_type : [job_type]
      );
    if (hasSalary === "true") query.whereNotNull("jobSalary");
    if (job_premium_status)
      query.whereIn(
        "job_premium_status",
        Array.isArray(job_premium_status) ? job_premium_status : [job_premium_status]
      );

    const jobs = await query
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`)
      .orderBy("created_at", "desc")
      .limit(Number(limit) + 1)
      .offset(offset);

    const hasMore = jobs.length > limit;
    if (hasMore) jobs.pop();

    // Render template instead of returning JSON
    res.render('jobs', { 
      jobs: jobs, 
      hasMore: hasMore,
      currentPage: parseInt(page),
      filters: req.query 
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// admin only – optional ?q= filters by HR email, job name, or company name
router.get("/adm", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    let query = db("jobs").select("*").orderBy("created_at", "desc");
    if (q) {
      const pattern = "%" + q.replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
      query = query.whereRaw(
        '"company_email" ILIKE ? OR "jobName" ILIKE ? OR "companyName" ILIKE ?',
        [pattern, pattern, pattern]
      );
    }
    const rows = await query;
    const jobIds = rows.map((r) => r.id);
    if (jobIds.length === 0) {
      return res.json({ data: rows.map((j) => ({ ...j, cv_stats: { tried: 0, succeeded: 0, failed: 0 }, cv_accepted: [], cv_refused: [] })) });
    }
    const [succeededByJob, failedByJob, acceptedRows, refusedRows] = await Promise.all([
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
          db.raw('(SELECT DISTINCT ON (user_id) user_id, file_url FROM resumes ORDER BY user_id, updated_at DESC NULLS LAST) as r'),
          "r.user_id",
          "ja.user_id"
        )
        .whereIn("ja.job_id", jobIds)
        .select("ja.job_id", "ja.user_id", "ja.created_at", "u.user_name", "u.user_email", "r.file_url as cv_url"),
      db("cv_refusals as cr")
        .join("users as u", "u.user_uid", "cr.user_id")
        .leftJoin(
          db.raw('(SELECT DISTINCT ON (user_id) user_id, file_url FROM resumes ORDER BY user_id, updated_at DESC NULLS LAST) as r'),
          "r.user_id",
          "cr.user_id"
        )
        .whereIn("cr.job_id", jobIds)
        .select("cr.job_id", "cr.user_id", "cr.created_at", "cr.complaint_sent", "u.user_name", "u.user_email", "r.file_url as cv_url"),
    ]);
    const succeededMap = new Map(succeededByJob.map((r) => [r.job_id, parseInt(r.n || 0, 10)]));
    const failedMap = new Map(failedByJob.map((r) => [r.job_id, parseInt(r.n || 0, 10)]));
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
            res.status(200).json({ message: "Search term count incremented" })
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

// Phase 3: Top candidate matches for a job (Pinecone semantic search)
router.get("/:id/top-candidates", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const topK = Math.min(100, Math.max(1, parseInt(req.query.topK, 10) || 100)); // Default 100, max 100
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
    const { getTopCandidatesForJob } = require("../services/pineconeCandidates");
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
      topK
    );
    // Only return candidates that pass the score threshold
    const qualifiedMatches = matches.filter((m) => (m.score || 0) >= effectiveMinScore);
    const userIds = qualifiedMatches.map((m) => m.id).filter(Boolean);
    if (userIds.length === 0) {
      return res.json({ job_id: jobId, candidates: [] });
    }
    const users = await db("users")
      .whereIn("user_uid", userIds)
      .select("user_uid", "user_name", "user_email");
    const userMap = Object.fromEntries(users.map((u) => [u.user_uid, u]));

    const resumeRows = await db("resumes")
      .whereIn("user_id", userIds)
      .orderBy("updated_at", "desc")
      .select("user_id", "file_url", "file_name");
    const resumeMap = {};
    resumeRows.forEach((r) => {
      if (!resumeMap[r.user_id]) resumeMap[r.user_id] = r;
    });

    // Last visit info per user: aggregate from visitors table
    const lastSeenRows = await db("visitors")
      .whereIn("user_id", userIds)
      .select("user_id")
      .groupBy("user_id")
      .max("last_seen as last_seen");
    const lastSeenMap = {};
    lastSeenRows.forEach((row) => {
      lastSeenMap[row.user_id] = row.last_seen;
    });
    const candidates = qualifiedMatches.map((m) => {
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
      String(req.query.assessWithGemini || "").trim().toLowerCase() === "1" ||
      String(req.query.assessWithGemini || "").trim().toLowerCase() === "true";
    const assessLimit = Math.min(
      20,
      Math.max(1, parseInt(req.query.assessLimit, 10) || 10)
    );

    if (assessWithGemini && candidates.length > 0) {
      const { assessCandidateAlignment } = require("../services/geminiCandidateAssessment");
      const { extractTextFromCv } = require("../services/cvTextExtractor");

      const toAssess = candidates
        .filter((c) => c.cv_url)
        .slice(0, assessLimit);

      const assessOne = async (c) => {
        try {
          const cvText = await extractTextFromCv(c.cv_url, c.cv_file_name);
          if (!cvText || cvText.length < 50) {
            return { ...c, gemini_assessment: { error: "Could not extract CV text" } };
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

      const assessed = await Promise.all(toAssess.map(assessOne));
      const assessedMap = Object.fromEntries(assessed.map((a) => [a.user_id, a]));
      const result = candidates.map((c) => assessedMap[c.user_id] || c);
      return res.json({ job_id: jobId, candidates: result });
    }

    res.json({ job_id: jobId, candidates });
  } catch (err) {
    console.error("jobs top-candidates error:", err);
    res.status(500).json({ error: err.message || "Failed to get top candidates" });
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
          db.raw('(SELECT DISTINCT ON (user_id) user_id, file_url FROM resumes ORDER BY user_id, updated_at DESC NULLS LAST) as r'),
          "r.user_id",
          "ja.user_id"
        )
        .where("ja.job_id", jobId)
        .select("ja.user_id", "ja.created_at", "u.user_name", "u.user_email", "r.file_url as cv_url")
        .orderBy("ja.created_at", "desc"),
      db("cv_refusals as cr")
        .join("users as u", "u.user_uid", "cr.user_id")
        .leftJoin(
          db.raw('(SELECT DISTINCT ON (user_id) user_id, file_url FROM resumes ORDER BY user_id, updated_at DESC NULLS LAST) as r'),
          "r.user_id",
          "cr.user_id"
        )
        .where("cr.job_id", jobId)
        .select("cr.user_id", "cr.created_at", "cr.complaint_sent", "u.user_name", "u.user_email", "r.file_url as cv_url")
        .orderBy("cr.created_at", "desc"),
      db("job_form_submissions").where("job_id", jobId).select("*").orderBy("created_at", "desc"),
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
    res.json({ removed: deleted > 0, message: deleted > 0 ? "Application removed" : "Application not found" });
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
    res.json({ removed: deleted > 0, message: deleted > 0 ? "Refusal removed - user can try again" : "Refusal not found" });
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
    res.json({ updated: updated > 0, message: updated > 0 ? "Complaint reset - user can complain again" : "Refusal not found" });
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
        prioritize: prioritize === true || prioritize === "true",
        dont_send_email: dont_send_email === true || dont_send_email === "true",
        job_status: "approved",
      })
      .returning("id");

    if (inserted) {
      await sendNewJobEmail({
        id: inserted.id,
        jobName: jName,
        companyName: cName,
        company_email,
        jobSalary,
        dont_send_email: dont_send_email === true || dont_send_email === "true",
      });
      // Index job in Pinecone for "jobs for user" recommendations
      upsertJob(inserted.id, {
        jobName: jName,
        jobDescription,
        job_experience,
        job_city,
        job_type,
      }).catch((err) => console.error("[pinecone] Failed to index job:", err.message));
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
      job.companyName &&
      job.jobName &&
      job.user_uid &&
      job.category_id;

    if (hasRequiredFields) {
      const jName = String(job.jobName || "").trim();
      const cName = String(job.companyName || "").trim();
      const key = jName + "|" + cName;

      if (seenInBatch.has(key)) {
        failedJobs.push({ index, jobName: jName, error: "Duplicate within batch" });
        continue;
      }
      if (await isBlacklisted(job.company_email, job.companyName)) {
        failedJobs.push({ index, jobName: jName, error: "Blacklisted company" });
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
        job_premium_status: 'regular',
        isHelio: job.isHelio || false,
        prioritize: job.prioritize === true || job.prioritize === "true",
        dont_send_email: job.dont_send_email === true || job.dont_send_email === "true",
        company_logo: job.company_logo || null
      });
    } else {
      console.error(`⚠️ JOB FAILED VALIDATION (Index: ${index}):`, {
        jobName: job.jobName || "UNKNOWN",
        company: job.companyName || "UNKNOWN",
        reason: "Missing required fields (companyName, jobName, user_uid, or category_id)"
      });
      failedJobs.push({
        index,
        jobName: job.jobName || "Unknown",
        error: "Missing required fields"
      });
    }
  }

  // If everything failed validation, stop here
  if (validJobs.length === 0) {
    return res.status(400).json({ 
      error: "No valid jobs to insert", 
      failedCount: failedJobs.length 
    });
  }

  try {
    const existingRows = await db("jobs")
      .select("jobName", "companyName")
      .where("job_status", "approved");
    const existingSet = new Set(
      existingRows.map((r) => String(r.jobName || "").trim() + "|" + String(r.companyName || "").trim())
    );

    const toInsert = validJobs.filter((j) => !existingSet.has(j.jobName + "|" + j.companyName));
    const skippedAsDuplicates = validJobs.length - toInsert.length;

    if (skippedAsDuplicates > 0) {
      console.warn(`[!] Skipped ${skippedAsDuplicates} jobs – duplicate of existing approved job`);
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
    const insertedJobs = toInsert.map((j, i) => ({ ...j, id: ids[i]?.id ?? ids[i] }));
    for (const j of insertedJobs) {
      upsertJob(j.id, {
        jobName: j.jobName,
        jobDescription: j.jobDescription,
        job_experience: j.job_experience,
        job_city: j.job_city,
        job_type: j.job_type,
      }).catch((err) => console.error("[pinecone] Failed to index job:", err.message));
    }

    // Send one email per company (group by company_email to avoid duplicates when company uploads multiple jobs)
    const jobsWithIds = toInsert.map((j, i) => ({ ...j, id: ids[i]?.id ?? ids[i] }))
      .filter((j) => !j.dont_send_email && (j.company_email || "").trim());
    const byCompany = new Map();
    for (const j of jobsWithIds) {
      const key = (j.company_email || "").trim().toLowerCase();
      if (!byCompany.has(key)) byCompany.set(key, []);
      byCompany.get(key).push(j);
    }
    const companies = Array.from(byCompany.values());
    const emailStats = { queued: 0, skippedNoEmail: toInsert.length - jobsWithIds.length, skipped: {} };
    for (let i = 0; i < companies.length; i++) {
      const result = await sendNewJobEmailToCompany(companies[i], i, companies.length);
      if (result.queued) {
        emailStats.queued++;
      } else {
        const r = result.reason || "unknown";
        emailStats.skipped[r] = (emailStats.skipped[r] || 0) + 1;
      }
    }

    console.log(`✅ SUCCESS: Inserted ${ids.length} jobs. Emails: ${emailStats.queued} queued, ${companies.length - emailStats.queued} skipped.`);
    if (failedJobs.length > 0) {
      console.warn(`[!] Note: ${failedJobs.length} jobs were skipped due to errors.`);
    }

    res.status(201).json({ 
      message: "Jobs inserted. Emails will be sent over the next 2-3 hours (see emailQueue).", 
      insertedCount: ids.length,
      failedCount: failedJobs.length,
      skippedAsDuplicates,
      failedJobs: failedJobs,
      emailQueue: {
        companiesWithEmail: companies.length,
        queued: emailStats.queued,
        skippedNoEmail: emailStats.skippedNoEmail,
        skipped: emailStats.skipped,
        pending: await getQueueCount()
      }
    });
  } catch (err) {
    // This catches DB-level crashes (e.g. unique constraint violations)
    console.error("🔥 DATABASE CRITICAL ERROR:", err.message);
    res.status(500).json({ error: "Database rejected the batch", details: err.message });
  }
});

// PATCH route to update a job
const JOB_UPDATE_WHITELIST = [
  "companyName", "user_uid", "company_email", "jobName", "jobSalary", "jobDescription",
  "job_experience", "job_city", "job_address", "job_type", "jobIsUrgent", "category_id",
  "job_premium_status", "premium_until", "isHelio", "job_status", "cvs_sent", "company_logo", "jobSalary_min",
  "view_count", "expires_at", "prioritize", "dont_send_email", "marketing_email_sent",
  "cv_submissions_email_sent", "disable_cv_filter", "accept_form_submissions", "updated_at",
];
// Admin apps often send camelCase; map to DB column names
const CAMEL_TO_SNAKE = {
  acceptFormSubmissions: "accept_form_submissions",
  disableCvFilter: "disable_cv_filter",
  premiumUntil: "premium_until",
};

const patchOrPutJob = async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (!jobId || isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid job id" });
    }
    const body = req.body;

    console.log("[PATCH/PUT jobs] jobId=" + jobId + " body keys=" + Object.keys(body).join(",") + " accept_form_submissions=" + JSON.stringify(body.accept_form_submissions ?? body.acceptFormSubmissions));

    const updateData = {};
    const booleanFields = new Set(["accept_form_submissions", "disable_cv_filter", "isHelio", "jobIsUrgent", "prioritize", "dont_send_email", "marketing_email_sent", "cv_submissions_email_sent"]);
    for (const key of Object.keys(body)) {
      const dbKey = CAMEL_TO_SNAKE[key] || key;
      if (JOB_UPDATE_WHITELIST.includes(dbKey) && body[key] !== undefined) {
        let val = body[key];
        if (dbKey === "premium_until") {
          val = parsePremiumUntil(val);
          if (val === null && body[key] !== "" && body[key] !== undefined) continue; // invalid, skip
        } else if (booleanFields.has(dbKey)) {
          val = val === true || val === 1 || val === "true" || val === "1" || val === "on";
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
      const rawResult = await db.raw("UPDATE jobs SET accept_form_submissions = ? WHERE id = ?", [boolVal, jobId]);
      const rowCount = rawResult.rowCount ?? rawResult[1] ?? 0;
      if (rowCount === 0) {
        return res.status(404).json({ error: "Job not found" });
      }
      delete updateData.accept_form_submissions;
    }

    if (Object.keys(updateData).length > 0) {
      const count = await db("jobs").where("id", jobId).update(updateData);
      if (count === 0) {
        return res.status(404).json({ error: "Job not found" });
      }
      // Re-index or remove from Pinecone when job content/expiry changes
      const pineconeFields = ["jobName", "jobDescription", "job_experience", "job_type", "job_city", "expires_at"];
      const touchedPinecone = Object.keys(updateData).some((k) => pineconeFields.includes(k));
      if (touchedPinecone) {
        const job = await db("jobs").where("id", jobId).select("jobName", "jobDescription", "job_description", "job_experience", "job_type", "job_city", "expires_at").first();
        if (job) {
          if (job.expires_at && new Date(job.expires_at) <= new Date()) {
            deleteJob(jobId).catch((err) => console.error("[pinecone] Failed to delete job:", err.message));
          } else {
            upsertJob(jobId, {
              jobName: job.jobName,
              jobDescription: job.jobDescription || job.job_description,
              job_experience: job.job_experience,
              job_type: job.job_type,
              job_city: job.job_city,
            }).catch((err) => console.error("[pinecone] Failed to re-index job:", err.message));
          }
        }
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
  const jobId = req.params.id;

  try {
    const count = await db("jobs").where("id", jobId).del();
    if (count === 0) {
      return res.status(404).json({ error: "Job not found" });
    }
    deleteJob(jobId).catch((err) => console.error("[pinecone] Failed to delete job:", err.message));
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
    const pendingRows = await db("new_job_email_queue as q")
      .join("jobs as j", "j.id", "q.job_id")
      .select(
        "q.job_id",
        db.raw('j."jobName" as job_name'),
        db.raw('j."companyName" as company_name'),
        "j.company_email",
        "q.send_after"
      )
      .orderBy("q.send_after", "asc");
    const pending = pendingRows.map((r) => ({
      job_id: r.job_id,
      job_name: r.job_name,
      company_name: r.company_name,
      company_email: r.company_email,
      send_after: r.send_after,
      status: "queued",
    }));

    const hasMarketingSent = await db.schema.hasColumn("jobs", "marketing_email_sent");
    const hasGeneralMarketingSent = await db.schema.hasColumn("jobs", "general_marketing_email_sent");
    const sentFlagCol = hasMarketingSent ? "marketing_email_sent" : hasGeneralMarketingSent ? "general_marketing_email_sent" : null;
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
           ORDER BY s.sent_at DESC`
        )
      : { rows: [] };
    const sentData = Array.isArray(sentRows) ? sentRows : (sentRows?.rows || []);
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
      summary: { queued: pending.length, sent: sent.length },
    };
  } catch (e) {
    if (e.code === "42P01") return { pending: [], sent: [], summary: { queued: 0, sent: 0 } };
    throw e;
  }
};

router.kickEmailQueue = () => {
  newJobEmailProcessorScheduled = true;
  processNewJobEmailQueue();
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
    if (e.code === "23505") return res.status(409).json({ error: "Email already blacklisted" });
    console.error("blacklist POST error:", e);
    res.status(500).json({ error: e.message });
  }
});

router.delete("/blacklist/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email required" });
    const count = await db("blacklisted_company_emails").where("email", email).del();
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
    .select("id", "jobName", "companyName", "company_email", "jobSalary", "dont_send_email")
    .whereIn("id", ids)
    .where("job_status", "approved");
  for (const j of jobs) {
    await sendNewJobEmail({
      ...j,
      dont_send_email: j.dont_send_email === true || j.dont_send_email === 1,
    });
  }
  return { added: jobs.length, pending: await getQueueCount() };
};

function triggerNewJobEmailQueue() {
  if (!newJobEmailProcessorScheduled) {
    newJobEmailProcessorScheduled = true;
    processNewJobEmailQueue();
  }
}

router.triggerNewJobEmailQueue = triggerNewJobEmailQueue;
module.exports = router;

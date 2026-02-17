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

// Use the same environment-based Knex config as the main app
const knexConfig = require("../knexfile");
const environment = process.env.NODE_ENV || "development";
const db = knex(knexConfig[environment]);

// Email for freshly uploaded jobs (to HR)
const NEW_JOB_MAIL_USER = (process.env.PROPOSITIONAL_MAIL_USER || "").trim();
const NEW_JOB_MAIL_PASS = (process.env.PROPOSITIONAL_MAIL_PASS || "").trim().replace(/\s/g, "");
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

// Bulk emails spread over 2 hours
const BULK_SPREAD_MS = 2 * 60 * 60 * 1000;       // 2 hours total window
const MIN_DELAY_BETWEEN_SENDS_MS = 60 * 1000;     // at least 1 min between sends
const MAX_DELAY_BETWEEN_SENDS_MS = 5 * 60 * 1000; // random 1–5 min before next check

let newJobEmailLastSentAt = 0;
let newJobEmailProcessorScheduled = false;

async function hasRecentlySentToCompany(companyEmail) {
  if (!companyEmail) return false;
  try {
    const row = await db("new_job_email_sent")
      .where("company_email_lower", companyEmail)
      .whereRaw("sent_at > now() - interval '24 hours'")
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
       WHERE new_job_email_sent.sent_at < now() - interval '24 hours'
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
(async () => {
  const n = await getQueueCount();
  if (n > 0) {
    newJobEmailProcessorScheduled = true;
    processNewJobEmailQueue();
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
    const now = new Date();
    const row = await db("new_job_email_queue as q")
      .join("jobs as j", "j.id", "q.job_id")
      .select(
        "q.id as queue_id",
        "q.job_id",
        "q.company_email_lower",
        "q.send_after",
        "j.jobName",
        "j.companyName",
        "j.company_email",
        "j.jobSalary",
        "j.jobSalary_min"
      )
      .where("q.send_after", "<=", now)
      .orderBy("q.send_after")
      .first();
    if (!row) {
      const nextRow = await db("new_job_email_queue").select("send_after").orderBy("send_after").first();
      if (nextRow) {
        const waitMs = Math.max(
          MIN_DELAY_BETWEEN_SENDS_MS,
          new Date(nextRow.send_after).getTime() - Date.now()
        );
        newJobEmailProcessorScheduled = true;
        setTimeout(processNewJobEmailQueue, waitMs);
      } else {
        newJobEmailProcessorScheduled = false;
      }
      return;
    }
    const companyEmail = (row.company_email_lower || "").trim().toLowerCase();
    if (companyEmail && (await hasRecentlySentToCompany(companyEmail))) {
      await db("new_job_email_queue").where("id", row.queue_id).del();
      processNewJobEmailQueue();
      return;
    }
    const claimed = companyEmail && (await claimAndSendToCompany(companyEmail));
    if (companyEmail && !claimed) {
      await db("new_job_email_queue").where("id", row.queue_id).del();
      processNewJobEmailQueue();
      return;
    }
    const job = {
      id: row.job_id,
      jobName: row.jobName,
      companyName: row.companyName,
      company_email: row.company_email,
      jobSalary: row.jobSalary,
      jobSalary_min: row.jobSalary_min,
    };
    newJobEmailLastSentAt = Date.now();
    const jobLink = `${SITE_BASE_URL}/vakansia/${slugify(job.jobName)}-${job.id}`;
    const toEmail = (job.company_email || "").trim().split(/[,;]/)[0].trim();
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
<p>ინტერნეტში თქვენი ვაკანსია "${job.jobName}" ვიპოვეთ და ჩვენს საიტზე (<a href="https://samushao.ge">samushao.ge</a>) განვათავსეთ, ბოდიშს გიხდით თუ ეს არ უნდა გვექნა. თუ ცალსახად წინააღმდეგი ხართ, წავშლით.</p>
<p>ხოლო თუ დაინტერესებული ხართ რომ ვაკანსია უფრო მეტმა ნახოს, გთავაზობთ ვითანამშრომლოთ.</p>
<p>ფასების შესახებ ინფორმაცია:</p>
<p>1. სტანდარტული განცხადება - 50 ლარი</p>
<p>2. პრემიუმ განცხადება - 10 დღე მთავარ გვერდზე - 70 ლარი</p>
<p>3. პრემიუმ+ განცხადება - ყველაზე მაღალი ხილვადობა, 30 დღე მთავარ გვერდზე + პრიორიტეტი "მსგავს ვაკანსიებში" - 250 ლარი</p>
<p>სტატისტიკურად, ვაკანსიები სადაც ანაზღაურება 1200 ლარი ან მეტია და გამოცდილება 2 წელზე მეტი არ მოითხოვება, კარგ გამოხმაურებას იღებენ და ბევრი რეზიუმეც იგზავნება, ხოლო თუ ანაზღაურება 1200 ლარზე ნაკლებია, ბევრი განცხადება იგნორდება.</p>
<p>${salaryParagraph}</p>
<p>${lowSalaryBonus}</p>
<p>თუ დაინტერესდებით, ვითანამშრომლოთ!</p>
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
    const existingJob = await db("new_job_email_queue").where("job_id", job.id).first();
    if (existingJob) return { queued: false, reason: "duplicate_job_in_queue" };
    const existingCompany = await db("new_job_email_queue").where("company_email_lower", companyEmail).first();
    if (existingCompany) return { queued: false, reason: "company_already_in_queue" };
  } catch (e) {
    if (e.code === "42P01") { /* table doesn't exist yet */ }
    else throw e;
  }
  if (await hasRecentlySentToCompany(companyEmail)) {
    return { queued: false, reason: "already_sent_last_24h" };
  }

  const now = Date.now();
  let sendAfterMs;
  if (opts.batchTotal != null && opts.batchTotal > 0 && opts.batchIndex != null) {
    const totalWindow = BULK_SPREAD_MS;
    const slotSize = totalWindow / opts.batchTotal;
    const base = opts.batchIndex * slotSize;
    const jitter = (Math.random() - 0.5) * slotSize * 0.4;
    sendAfterMs = now + Math.max(0, base + jitter);
  } else {
    sendAfterMs = now; // single job: send immediately
  }
  const sendAfter = new Date(sendAfterMs);
  await db("new_job_email_queue").insert({
    job_id: job.id,
    company_email_lower: companyEmail,
    send_after: sendAfter,
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
      .orderByRaw("CASE job_premium_status WHEN 'premiumPlus' THEN 1 WHEN 'premium' THEN 2 WHEN 'regular' THEN 3 ELSE 4 END")
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

// admin only
router.get("/adm", (req, res) => {
  let query = db("jobs").select("*");
  let countQuery = db("jobs").count("id as totalItems");

  query.orderBy("created_at", "desc");

  query
    .then((rows) => {
      countQuery
        .first()
        .then((result) => {
          res.json({
            data: rows,
          });
        })
        .catch((err) => res.status(500).json({ error: err.message }));
    })
    .catch((err) => res.status(500).json({ error: err.message }));
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

// get a specific job by ID
router.get("/:id", (req, res) => {
  db("jobs")
    .where("id", req.params.id)
    .first()
    .then((row) => {
      if (!row) {
        return res.status(404).json({ error: "Job not found" });
      }
      res.json(row);
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

// create a new job
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

router.post("/", upload.single("company_logo"), async (req, res) => {
  const {
    companyName,
    jobName,
    jobSalary,
    jobDescription,
    jobIsUrgent,
    user_uid,
    category_id,
    company_email,
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
router.patch("/:id", (req, res) => {
  const jobId = req.params.id;
  const updateData = req.body;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ error: "No fields provided to update" });
  }

  db("jobs")
    .where("id", jobId)
    .update(updateData)
    .then((count) => {
      if (count === 0) {
        return res.status(404).json({ error: "Job not found" });
      }
      res.status(200).json({ message: "Job updated successfully" });
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

// DELETE route to remove a job
router.delete("/:id", (req, res) => {
  const jobId = req.params.id;

  db("jobs")
    .where("id", jobId)
    .del()
    .then((count) => {
      if (count === 0) {
        return res.status(404).json({ error: "Job not found" });
      }
      res.status(200).json({ message: "Job deleted successfully" });
    })
    .catch((err) => res.status(500).json({ error: err.message }));
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

module.exports = router;

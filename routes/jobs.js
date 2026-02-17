const cors = require("cors");
const express = require("express");
const fs = require("fs");
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

const newJobTransporter =
  NEW_JOB_MAIL_USER && NEW_JOB_MAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: NEW_JOB_MAIL_USER, pass: NEW_JOB_MAIL_PASS },
      })
    : null;

// Cooldown between new-job emails (seconds) - avoids blasting; server-side, survives refresh
const NEW_JOB_EMAIL_COOLDOWN_SEC = 120;
const EMAIL_QUEUE_FILE = path.join(__dirname, "..", ".new-job-email-queue.json");

let newJobEmailQueue = [];
let newJobEmailLastSentAt = 0;
let newJobEmailProcessorScheduled = false;

function loadEmailQueue() {
  try {
    const data = fs.readFileSync(EMAIL_QUEUE_FILE, "utf8");
    const parsed = JSON.parse(data);
    newJobEmailQueue = Array.isArray(parsed.queue) ? parsed.queue : [];
    if (parsed.lastSentAt && typeof parsed.lastSentAt === "number") {
      newJobEmailLastSentAt = parsed.lastSentAt;
    }
    if (newJobEmailQueue.length > 0) {
      newJobEmailProcessorScheduled = true;
      processNewJobEmailQueue();
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Email queue load error:", e.message);
  }
}

function saveEmailQueue() {
  try {
    fs.writeFileSync(
      EMAIL_QUEUE_FILE,
      JSON.stringify({
        queue: newJobEmailQueue,
        lastSentAt: newJobEmailLastSentAt,
        updatedAt: Date.now(),
      }),
      "utf8"
    );
  } catch (e) {
    console.error("Email queue save error:", e.message);
  }
}

// Load persisted queue on startup
loadEmailQueue();

function processNewJobEmailQueue() {
  if (newJobEmailQueue.length === 0) {
    newJobEmailProcessorScheduled = false;
    return;
  }
  const now = Date.now();
  const elapsed = (now - newJobEmailLastSentAt) / 1000;
  if (newJobEmailLastSentAt > 0 && elapsed < NEW_JOB_EMAIL_COOLDOWN_SEC) {
    const waitMs = (NEW_JOB_EMAIL_COOLDOWN_SEC - elapsed) * 1000;
    newJobEmailProcessorScheduled = true;
    setTimeout(processNewJobEmailQueue, waitMs);
    return;
  }
  const job = newJobEmailQueue.shift();
  newJobEmailLastSentAt = Date.now();
  saveEmailQueue();
  const jobLink = `${SITE_BASE_URL}/vakansia/${slugify(job.jobName)}-${job.id}`;
  const mailOptions = {
    from: NEW_JOB_MAIL_USER,
    to: job.company_email.trim(),
    subject: `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`,
    html: NEW_JOB_HTML_TEMPLATE({ ...job, jobLink }),
  };
  newJobTransporter.sendMail(mailOptions, (err) => {
    if (err) {
      console.error("New job email error:", err);
    } else {
      console.log(`📧 Sent new-job email to ${job.company_email?.trim()} (job #${job.id}: ${job.jobName})`);
    }
    try {
      processNewJobEmailQueue();
    } catch (e) {
      console.error("Email queue processor error:", e);
      newJobEmailProcessorScheduled = false;
    }
  });
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

function sendNewJobEmail(job) {
  if (!newJobTransporter || !job.company_email || job.dont_send_email) return;
  newJobEmailQueue.push(job);
  saveEmailQueue();
  if (!newJobEmailProcessorScheduled) {
    newJobEmailProcessorScheduled = true;
    processNewJobEmailQueue();
  }
}

/**
 * Send one email per company when multiple jobs are uploaded (bulk).
 * Uses the first job's details for the email content.
 */
function sendNewJobEmailToCompany(jobs) {
  if (!newJobTransporter || !Array.isArray(jobs) || jobs.length === 0) return;
  const first = jobs[0];
  const email = (first.company_email || "").trim();
  if (!email || first.dont_send_email) return;
  sendNewJobEmail(first);
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
      sendNewJobEmail({
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

  jobsToInsert.forEach((job, index) => {
    // Define your "Deal Breakers" here
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
        return;
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
      // THE "FUCKING CONSOLE LOG" YOU REQUESTED
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
  });

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
    const jobsWithIds = toInsert.map((j, i) => ({ ...j, id: ids[i].id }))
      .filter((j) => !j.dont_send_email && (j.company_email || "").trim());
    const byCompany = new Map();
    for (const j of jobsWithIds) {
      const key = (j.company_email || "").trim().toLowerCase();
      if (!byCompany.has(key)) byCompany.set(key, []);
      byCompany.get(key).push(j);
    }
    for (const jobs of byCompany.values()) {
      sendNewJobEmailToCompany(jobs);
    }

    console.log(`✅ SUCCESS: Inserted ${ids.length} jobs.`);
    if (failedJobs.length > 0) {
      console.warn(`[!] Note: ${failedJobs.length} jobs were skipped due to errors.`);
    }

    res.status(201).json({ 
      message: "Processing complete", 
      insertedCount: ids.length,
      failedCount: failedJobs.length,
      skippedAsDuplicates,
      failedJobs: failedJobs
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

router.getEmailQueueStatus = () => ({
  pending: newJobEmailQueue.length,
  lastSentAt: newJobEmailLastSentAt || null,
  processorScheduled: newJobEmailProcessorScheduled,
});
router.kickEmailQueue = () => {
  newJobEmailProcessorScheduled = true;
  processNewJobEmailQueue();
};

router.requeueJobsByIds = async (jobIds) => {
  if (!Array.isArray(jobIds) || jobIds.length === 0) return { added: 0 };
  const ids = jobIds.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
  if (ids.length === 0) return { added: 0 };
  const jobs = await db("jobs")
    .select("id", "jobName", "companyName", "company_email", "jobSalary", "dont_send_email")
    .whereIn("id", ids)
    .where("job_status", "approved");
  for (const j of jobs) {
    sendNewJobEmail({
      ...j,
      dont_send_email: j.dont_send_email === true || j.dont_send_email === 1,
    });
  }
  return { added: jobs.length, pending: newJobEmailQueue.length };
};

module.exports = router;

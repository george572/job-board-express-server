const cors = require("cors");
const express = require("express");
const knex = require("knex"); // Assuming knex.js is the config file
const router = express.Router();
router.use(cors()); // Ensure CORS is applied to this router
const multer = require("multer");
const path = require("path");

const db = knex(require("../knexfile").development); // Assuming you're using 'development' from knexfile.js

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

    let query = db("jobs").select("*").where("job_status", "approved");

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

    // Fetch jobs with premium status priority
    const jobs = await query
      .orderByRaw("CASE job_premium_status WHEN 'premiumPlus' THEN 1 WHEN 'premium' THEN 2 WHEN 'regular' THEN 3 ELSE 4 END")
      .orderBy("created_at", "desc")
      .limit(Number(limit) + 1)
      .offset(offset);

    // Determine if more jobs exist after applying filters
    const hasMore = jobs.length > limit;
    if (hasMore) jobs.pop(); // Remove extra job if fetched

    res.json({ data: jobs, hasMore, currentPage: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

router.post("/", upload.single("company_logo"), (req, res) => {
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

  db("jobs")
    .insert({
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
    })
    .returning("id")
    .then((ids) => {
      res.status(201).json({ message: "Job created", jobId: ids[0] });
    })
    .catch((err) => res.status(500).json({ error: err.message }));
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

  jobsToInsert.forEach((job, index) => {
    // Define your "Deal Breakers" here
    const hasRequiredFields = 
      job.companyName && 
      job.jobName && 
      job.user_uid && 
      job.category_id;

    if (hasRequiredFields) {
      validJobs.push({
        companyName: job.companyName,
        jobName: job.jobName,
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
        job_premium_status: job.job_premium_status || null,
        isHelio: job.isHelio || false,
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
    const ids = await db("jobs").insert(validJobs).returning("id");
    
    console.log(`✅ SUCCESS: Inserted ${ids.length} jobs.`);
    if (failedJobs.length > 0) {
      console.warn(`[!] Note: ${failedJobs.length} jobs were skipped due to errors.`);
    }

    res.status(201).json({ 
      message: "Processing complete", 
      insertedCount: ids.length,
      failedCount: failedJobs.length,
      failedJobs: failedJobs // Send this back so your Python script knows what to fix
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

module.exports = router;

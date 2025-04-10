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
      hasSalary
    } = req.query;

    const offset = (page - 1) * limit;

    let query = db("jobs").select("*").where("job_status", "approved");

    // Apply filters
    if (company) query.where("companyName", company);
    if (category) query.whereIn("category_id", Array.isArray(category) ? category : [category]);
    if (job_experience) query.whereIn("job_experience", Array.isArray(job_experience) ? job_experience : [job_experience]);
    if (job_city) query.whereIn("job_city", Array.isArray(job_city) ? job_city : [job_city]);
    if (job_type) query.whereIn("job_type", Array.isArray(job_type) ? job_type : [job_type]);
    if (hasSalary === "true") query.whereNotNull("jobSalary");

    // Fetch jobs
    const jobs = await query.orderBy("created_at", "desc").limit(limit + 1).offset(offset);
    
    // Determine if more jobs exist
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

  query.orderBy("created_at", "desc")

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
router.post("/search", (req, res) => {
  const { searchTerm } = req.body;
  if (!searchTerm) {
    return res.status(400).json({ error: "Search term is required" });
  }
  db("searchterms")
    .insert({
      searchTerm,
    })
    .then(() => res.status(200).json({ message: "Search term saved" }))
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
    })
    .returning("id")
    .then((ids) => {
      res.status(201).json({ message: "Job created", jobId: ids[0] });
    })
    .catch((err) => res.status(500).json({ error: err.message }));
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

const cors = require("cors");
const express = require("express");
const knex = require("knex"); // Assuming knex.js is the config file
const router = express.Router();
router.use(cors()); // Ensure CORS is applied to this router
const multer = require("multer");
const path = require("path");

const db = knex(require("../knexfile").development); // Assuming you're using 'development' from knexfile.js

// get all jobs
router.get("/", (req, res) => {
  const { category, company, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  let query = db("jobs").select("*").where("job_status", "approved");
  let countQuery = db("jobs")
    .count("id as totalItems")
    .where("job_status", "approved");

  if (company) {
    query.where("companyName", company);
    countQuery.where("companyName", company);
  }

  if (category) {
    query.where("category_id", category);
    countQuery.where("category_id", category);
  }

  query.orderBy("created_at", "desc").limit(limit).offset(offset);

  query
    .then((rows) => {
      countQuery
        .first()
        .then((result) => {
          const totalItems = result.totalItems;
          const totalPages = Math.ceil(totalItems / limit);

          res.json({
            data: rows,
            totalItems,
            totalPages,
            currentPage: page,
          });
        })
        .catch((err) => res.status(500).json({ error: err.message }));
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

// admin only
router.get("/adm", (req, res) => {
  const { category, company, status, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  let query = db("jobs").select("*");
  let countQuery = db("jobs").count("id as totalItems");

  if (status && ["pending", "approved", "hidden"].includes(status)) {
    query.where("job_status", status);
    countQuery.where("job_status", status);
  }

  if (company) {
    query.where("companyName", company);
    countQuery.where("companyName", company);
  }

  if (category) {
    query.where("category_id", category);
    countQuery.where("category_id", category);
  }

  query.orderBy("created_at", "desc").limit(limit).offset(offset);

  query
    .then((rows) => {
      countQuery
        .first()
        .then((result) => {
          const totalItems = result.totalItems;
          const totalPages = Math.ceil(totalItems / limit);

          res.json({
            data: rows,
            totalItems,
            totalPages,
            currentPage: page,
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

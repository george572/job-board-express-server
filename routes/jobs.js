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
      category, company, job_experience, job_city,
      job_type, page = 1, limit = 10, hasSalary,
    } = req.query;
    const pg = Number(page);
    const lim = Number(limit);
    const offset = (pg - 1) * lim;

    // Build base filter query
    const baseQ = db("jobs").where("job_status", "approved");
    if (company)      baseQ.where("companyName", company);
    if (category)     baseQ.whereIn("category_id", Array.isArray(category) ? category : [category]);
    if (job_experience) baseQ.whereIn("job_experience", Array.isArray(job_experience) ? job_experience : [job_experience]);
    if (job_city)     baseQ.whereIn("job_city", Array.isArray(job_city) ? job_city : [job_city]);
    if (job_type)     baseQ.whereIn("job_type", Array.isArray(job_type) ? job_type : [job_type]);
    if (hasSalary === "true") baseQ.whereNotNull("jobSalary");

    // Fetch one more item than needed to check for hasMore
    const jobs = await baseQ
      .clone()
      .select("*")
      .orderBy("created_at", "desc")
      .limit(lim + 1)  // Fetch lim + 1
      .offset(offset);

    // Determine hasMore and adjust the results
    const hasMore = jobs.length > lim;
    if (hasMore) {
      jobs.pop(); // Remove the extra item
    }

    // Optional: Count total items if needed for other purposes
    // const [{ count }] = await baseQ.clone().count("* as count");
    // const totalCount = parseInt(count, 10);

    res.json({
      data: jobs,
      currentPage: pg,
      hasMore,
      // totalItems: totalCount, // Optional if needed
    });
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

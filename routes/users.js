const cors = require("cors");
const express = require("express");
const knex = require("knex");
const path = require("path");
const router = express.Router();

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const knexConfig = require("../knexfile");
const environment = process.env.NODE_ENV || "development";
const db = knex(knexConfig[environment]);

router.use(cors()); // Ensure CORS is applied to this router

// Check if user exists using Knex
const checkIfUserExists = (uid) => {
  return db("users").where("user_uid", uid).first();
};

// Route to get all users
router.get("/", (req, res) => {
  db("users")
    .select("*")
    .orderBy("created_at", "desc")
    .then((rows) => {
      if (!rows) {
        return res.status(404).json({ error: "Users not found" });
      }
      res.json(rows); // Return all users
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

// Top jobs for a user (jobs where this user is a great fit, via Pinecone)
router.get("/:id/top-jobs", async (req, res) => {
  try {
    const userId = req.params.id;
    const topK = Math.min(50, Math.max(1, parseInt(req.query.topK, 10) || 50));
    const minScore = parseFloat(req.query.minScore);
    const effectiveMinScore = Number.isFinite(minScore) ? minScore : 0.4;

    const { getTopJobsForUser } = require("../services/pineconeJobs");
    const matches = await getTopJobsForUser(userId, topK, effectiveMinScore);
    const jobIds = matches.map((m) => parseInt(m.id, 10)).filter((id) => !isNaN(id));
    if (jobIds.length === 0) {
      return res.json({ user_id: userId, jobs: [] });
    }

    const jobs = await db("jobs")
      .whereIn("id", jobIds)
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .select("id", "jobName", "companyName", "job_city", "job_experience", "job_type", "jobSalary", "job_premium_status", "prioritize");
    const scoreMap = Object.fromEntries(matches.map((m) => [parseInt(m.id, 10), m.score]));
    const sorted = jobIds
      .map((id) => {
        const job = jobs.find((j) => j.id === id);
        if (!job) return null;
        return { ...job, score: scoreMap[id] ?? 0 };
      })
      .filter(Boolean);

    res.json({ user_id: userId, jobs: sorted });
  } catch (err) {
    console.error("users top-jobs error:", err);
    res.status(500).json({ error: err.message || "Failed to get top jobs" });
  }
});

// Route to get a user
router.get("/:id", (req, res) => {
  const { id } = req.params; // Get the `id` from the route parameter

  db("users")
    .where("user_uid", id)
    .first()
    .then((row) => {
      if (!row) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json(row); // Return the matching user
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

// Signup/login user
router.post("/auth", (req, res) => {
  const { user_uid, user_name, user_email } = req.body;

  // Validate input
  if (!user_uid || !user_name || !user_email) {
    return res.status(400).json({ error: "All fields are required" });
  }

  // First check if user exists
  checkIfUserExists(user_uid)
    .then((existingUser) => {
      if (existingUser) {
        return res.status(201).json({ exists: true, user: existingUser });
      }

      // If user does not exist, add with user_type "user"
      db("users")
        .insert({
          user_uid,
          user_name,
          user_email,
          user_type: "user",
          wants_cv_to_be_sent: true,
        })
        .then(() => {
          res.status(201).json({
            user_uid,
            user_name,
            user_email,
            user_type: "user",
          });
        })
        .catch((err) => res.status(500).json({ error: err.message }));
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

// Update user details
router.patch("/:id", (req, res) => {
  const userId = req.params.id; // Get the user ID from the URL parameter
  const userData = req.body; // Get the updated data from the request body

  // Validate that at least one field is provided for update
  if (Object.keys(userData).length === 0) {
    return res.status(400).json({ error: "No fields provided to update" });
  }

  // Dynamically build the update query
  const updateFields = ["user_uid", "user_name", "user_email", "user_type"];
  const updateData = {};

  // Build dynamic update fields
  updateFields.forEach((field) => {
    if (userData[field]) {
      updateData[field] = userData[field];
    }
  });

  // If no valid fields are provided, return an error
  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  db("users")
    .where("user_uid", userId)
    .update(updateData)
    .then((count) => {
      if (count === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      res.status(200).json({ message: "User updated successfully" });
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

module.exports = router;

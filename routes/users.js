const cors = require("cors");
const express = require("express");

module.exports = function (db) {
  const router = express.Router();
  router.use(cors());

  const checkIfUserExists = (uid) => {
    return db("users").where("user_uid", uid).first();
  };

  router.get("/", (req, res) => {
    db("users")
      .select("*")
      .orderBy("created_at", "desc")
      .then((rows) => {
        if (!rows) {
          return res.status(404).json({ error: "Users not found" });
        }
        res.json(rows);
      })
      .catch((err) => res.status(500).json({ error: err.message }));
  });

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

  router.get("/:id", (req, res) => {
    const { id } = req.params;

    db("users")
      .where("user_uid", id)
      .first()
      .then((row) => {
        if (!row) {
          return res.status(404).json({ error: "User not found" });
        }
        res.json(row);
      })
      .catch((err) => res.status(500).json({ error: err.message }));
  });

  router.post("/auth", (req, res) => {
    const { user_uid, user_name, user_email } = req.body;

    if (!user_uid || !user_name || !user_email) {
      return res.status(400).json({ error: "All fields are required" });
    }

    checkIfUserExists(user_uid)
      .then((existingUser) => {
        if (existingUser) {
          return res.status(201).json({ exists: true, user: existingUser });
        }

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

  router.patch("/:id", (req, res) => {
    const userId = req.params.id;
    const userData = req.body;

    if (Object.keys(userData).length === 0) {
      return res.status(400).json({ error: "No fields provided to update" });
    }

    const updateFields = ["user_uid", "user_name", "user_email", "user_type"];
    const updateData = {};

    updateFields.forEach((field) => {
      if (userData[field]) {
        updateData[field] = userData[field];
      }
    });

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

  return router;
};

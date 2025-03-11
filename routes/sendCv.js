const express = require("express");
const knex = require("knex");
const nodemailer = require("nodemailer");
const cors = require("cors");

const router = express.Router();
const db = knex(require("../knexfile").development); // assuming knexfile.js is configured correctly
router.use(cors());

const transporter = nodemailer.createTransport({
  service: "gmail", // or use SMTP settings
  auth: {
    user: "info@samushao.ge",
    pass: "ozcg omye lxpo dkjd",
  },
});

router.post("/", (req, res) => {
  const { job_id, user_id } = req.body;

  // Get job information using Knex
  db("jobs")
    .where("id", job_id)
    .first()
    .then((job) => {
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Get resume information using Knex
      db("resumes")
        .where("user_id", user_id)
        .first()
        .then((resume) => {
          if (!resume) {
            return res.status(404).json({ error: "Resume not found" });
          }

          // Get user information using Knex
          db("users")
            .where("user_uid", user_id)
            .first()
            .then((user) => {
              if (!user) {
                return res.status(404).json({ error: "User not found" });
              }

              // Send email
              const mailOptions = {
                from: "your-email@gmail.com",
                to: job.company_email,
                subject: `New Application for ${job.jobName}`,
                html: `<p>ახალი CV გამოიგზავნა თქვენს ვაკანსიაზე: "${job.jobName}".</p>
                       <p>გადმოწერეთ სივი: <a href="${resume.file_url}">გადმოწერეთ CV</a></p>`,
              };

              transporter.sendMail(mailOptions, (error, info) => {
                if (error) {
                  console.error("Email sending error:", error);
                  return res.status(500).json({ error: "Failed to send email: " + error.message });
                }

                return res.json({
                  message: "CV sent successfully to company email",
                });
              });
            })
            .catch((err) => {
              console.error("Database error fetching user:", err);
              return res.status(500).json({ error: "Database error fetching user" });
            });
        })
        .catch((err) => {
          console.error("Database error fetching resume:", err);
          return res.status(500).json({ error: "Database error fetching resume" });
        });
    })
    .catch((err) => {
      console.error("Database error fetching job:", err);
      return res.status(500).json({ error: "Database error fetching job" });
    });
});

module.exports = router;

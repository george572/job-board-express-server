const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const nodemailer = require("nodemailer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const db = new sqlite3.Database("./database.db");
router.use(cors());

const transporter = nodemailer.createTransport({
  service: "gmail", // or use SMTP settings
  auth: {
    user: "tbilisiairporttransfers@gmail.com",
    pass: "coco icgg nmwh pgsm",
  },
});

router.post("/", (req, res) => {
  const { job_id, user_id } = req.body;

  // Get job information
  db.get(
    "SELECT company_email, jobName FROM jobs WHERE id = ?",
    [job_id],
    (err, job) => {
      if (err) {
        console.error("Database error fetching job:", err);
        return res.status(500).json({ error: "Database error fetching job" });
      }

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Get resume information
      db.get(
        "SELECT file_url FROM resumes WHERE user_id = ?",
        [user_id],
        (err, resume) => {
          if (err) {
            console.error("Database error fetching resume:", err);
            return res
              .status(500)
              .json({ error: "Database error fetching resume" });
          }

          if (!resume) {
            return res.status(404).json({ error: "Resume not found" });
          }

          // Get user information
          db.get(
            "SELECT user_name FROM users WHERE user_uid = ?",
            [user_id],
            (err, user) => {
              if (err) {
                console.error("Database error fetching user:", err);
                return res
                  .status(500)
                  .json({ error: "Database error fetching user" });
              }

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
                // Remove the fs.unlinkSync since tempFilePath is not defined
                if (error) {
                  console.error("Email sending error:", error);
                  return res
                    .status(500)
                    .json({ error: "Failed to send email: " + error.message });
                }

                // Only send the response if all previous steps were successful
                return res.json({
                  message: "CV sent successfully to company email",
                });
              });
            }
          );
        }
      );
    }
  );
});

module.exports = router;

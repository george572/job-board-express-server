const express = require("express");
const knex = require("knex");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");

// Load .env from project root (reliable when app is started from any cwd)
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const router = express.Router();
const db = knex(require("../knexfile").development);
router.use(cors());

const MAIL_USER = "info@samushao.ge";
const MAIL_PASS = (process.env.MAIL_PSW || "").trim();

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: MAIL_USER,
    pass: MAIL_PASS,
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

      // Increment cvs_sent for the job
      return db("jobs")
        .where("id", job_id)
        .increment("cvs_sent", 1)
        .returning("*")
        .then(() => job);
    })
    .then((job) => {
      // Get resume information using Knex
      return db("resumes")
        .where("user_id", user_id)
        .first()
        .then((resume) => {
          if (!resume) {
            return res.status(404).json({ error: "Resume not found" });
          }
          return { job, resume };
        });
    })
    .then(({ job, resume }) => {
      // Get user information using Knex
      return db("users")
        .where("user_uid", user_id)
        .first()
        .then((user) => {
          if (!user) {
            return res.status(404).json({ error: "User not found" });
          }

          if (!MAIL_PASS) {
            return reject(new Error("MAIL_PSW is not set in .env"));
          }

          // Send email (from must match auth user for Gmail)
          const mailOptions = {
            from: MAIL_USER,
            to: job.company_email,
            subject: `New Application for ${job.jobName}`,
            html: `<p>ახალი CV გამოიგზავნა თქვენს ვაკანსიაზე: "${job.jobName}".</p>
                   <p>CV-ის ბმული: ${resume.file_url}</p>
                   <p>კანდიდატის სახელი: ${user.user_name}</p>
                   <p>კანდიდატის ელ-ფოსტა: ${user.user_email}</p>`,
          };

      return new Promise((resolve, reject) => {
        transporter.sendMail(mailOptions, (error, info) => {
          if (error) {
            console.error("Email sending error:", error);
            return reject(
              new Error("Failed to send email: " + error.message)
            );
          }

          // Record that this user applied to this job (so we can disable "Send CV" on job page)
          db("job_applications")
            .insert({ user_id: user_id, job_id: job.id })
            .then(() =>
              resolve({
                message: "CV sent successfully to company email",
                job,
                resume,
                user,
              })
            )
            .catch((insertErr) => {
              console.error("job_applications insert error:", insertErr);
              // Still resolve success - email was sent
              resolve({
                message: "CV sent successfully to company email",
                job,
                resume,
                user,
              });
            });
        });
      });
        });
    })
    .then((result) => {
      res.json(result);
    })
    .catch((err) => {
      console.error("Database or email error:", err);
      // Prefer the error message, but fall back to any `error` field or a generic message
      const message = err?.message || err?.error || "An unexpected error occurred";
      return res.status(500).json({ error: message });
    });
});

module.exports = router;

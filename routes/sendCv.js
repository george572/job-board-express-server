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

      // Increment cvs_sent for the job
      return db("jobs")
        .where("id", job_id)
        .increment("cvs_sent", 1)
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

          // Send email
          const mailOptions = {
            from: "your-email@gmail.com",
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
                return reject({
                  error: "Failed to send email: " + error.message,
                });
              }

              resolve({
                message: "CV sent successfully to company email",
                job,
                resume,
                user,
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
      return res
        .status(500)
        .json({ error: err.message || "An unexpected error occurred" });
    });
});

module.exports = router;

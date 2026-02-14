const express = require("express");
const knex = require("knex");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");

// Load .env from project root (reliable when app is started from any cwd)
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const router = express.Router();
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);
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

router.post("/", async (req, res) => {
  const { job_id, user_id } = req.body;

  try {
    const job = await db("jobs").where("id", job_id).first();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    await db("jobs").where("id", job_id).increment("cvs_sent", 1);

    const resume = await db("resumes").where("user_id", user_id).first();
    if (!resume) {
      return res.status(404).json({ error: "Resume not found" });
    }

    const user = await db("users").where("user_uid", user_id).first();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!MAIL_PASS) {
      return res.status(500).json({ error: "Email service not configured" });
    }

    const mailOptions = {
      from: MAIL_USER,
      to: job.company_email,
      subject: `New Application for ${job.jobName}`,
      html: `<p>ახალი CV გამოიგზავნა თქვენს ვაკანსიაზე: "${job.jobName}".</p>
             <p>CV-ის ბმული: ${resume.file_url}</p>
             <p>კანდიდატის სახელი: ${user.user_name}</p>
             <p>კანდიდატის ელ-ფოსტა: ${user.user_email}</p>`,
    };

    await new Promise((resolve, reject) => {
      transporter.sendMail(mailOptions, (err) => {
        if (err) {
          console.error("Email sending error:", err);
          reject(new Error("Failed to send email: " + err.message));
        } else {
          resolve();
        }
      });
    });

    const insertPayload = { user_id, job_id: job.id };
    if (req.visitorId) insertPayload.visitor_id = req.visitorId;
    try {
      await db("job_applications").insert(insertPayload);
    } catch (insertErr) {
      console.error("job_applications insert error:", insertErr);
      // Email was sent; application record may already exist (duplicate)
    }

    return res.json({
      message: "CV sent successfully to company email",
      job,
      resume,
      user,
    });
  } catch (err) {
    if (res.headersSent) return;
    console.error("send-cv error:", err);
    const message = err?.message || err?.error || "An unexpected error occurred";
    return res.status(500).json({ error: message });
  }
});

module.exports = router;

const express = require("express");
const knex = require("knex");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");

// Load .env from project root (reliable when app is started from any cwd)
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const router = express.Router();
const knexConfig = require("../knexfile");
const { slugify } = require("../utils/slugify");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);
router.use(cors());

const MAIL_USER = "info@samushao.ge";
const MAIL_PASS = (process.env.MAIL_PSW || "").trim();

// Secondary Gmail for 4th CV propositional email - PROPOSITIONAL_MAIL_USER, PROPOSITIONAL_MAIL_PASS
const PROPOSITIONAL_MAIL_USER = (process.env.PROPOSITIONAL_MAIL_USER || "").trim();
const PROPOSITIONAL_MAIL_PASS = (process.env.PROPOSITIONAL_MAIL_PASS || "").trim().replace(/\s/g, "");

const APPLICANTS_MAIL_USER = (process.env.APPLICANTS_MAIL_USER || "").trim();
const APPLICANTS_MAIL_PASS = (process.env.APPLICANTS_MAIL_PASS || "").trim().replace(/\s/g, "");
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://samushao.ge";

const applicantsTransporter =
  APPLICANTS_MAIL_USER && APPLICANTS_MAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: APPLICANTS_MAIL_USER, pass: APPLICANTS_MAIL_PASS },
      })
    : null;

const APPLICANTS_HTML_TEMPLATE = (jobName, cvsSent, jobLink) => `
<p>გამარჯობა!</p>
<p>თქვენი ვაკანსია "<strong>${jobName}</strong>" უკვე <strong>${cvsSent}</strong> აპლიკანტს იღებს.</p>
<p>ვნახოთ საიტზე: <a href="${jobLink}">${jobLink}</a></p>
<p>— Samushao.ge</p>
`;

const PROPOSITIONAL_HTML_TEMPLATE = (cvsSent) => `
<p>სალამი!</p>
<p>ბოდიში, ჩვენ დაუკითხავად (მაგრამ კეთილი განზრახვით) დავდეთ თქვენი ვაკანსია ჩვენს საიტზე (<a href="https://samushao.ge">samushao.ge</a>), იმედია არ გაგაბრაზეთ.</p>
<p>იმის მიუხედავად რომ პრემიუმი არ არის, უკვე <strong>${cvsSent}</strong> რეზიუმე გამოიგზავნა მოკლე დროში.</p>
<p>თუ მოგწონთ ეს შედეგი და გინდათ თქვენი ვაკანსია დარჩეს საიტზე, ჩვენთან განცხადების დადება ფასიანია.</p>
`;

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: MAIL_USER,
    pass: MAIL_PASS,
  },
});

const hrNotifyTransporter =
PROPOSITIONAL_MAIL_USER && PROPOSITIONAL_MAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: {
          user: PROPOSITIONAL_MAIL_USER,
          pass: PROPOSITIONAL_MAIL_PASS,
        },
      })
    : null;

router.post("/", async (req, res) => {
  const { job_id, user_id } = req.body;

  try {
    const job = await db("jobs").where("id", job_id).first();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (job.expires_at && new Date(job.expires_at) <= new Date()) {
      return res.status(410).json({ error: "This vacancy has expired and is no longer accepting applications" });
    }

    const cvsSentBefore = job.cvs_sent || 0;
    const isThirdCv = cvsSentBefore === 2;

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

    // Applicants notification: "Your job has X applicants" from giorgi@samushao.ge – ONLY on 3rd CV
    const cvsSentNow = cvsSentBefore + 1;
    const isThirdCvForApplicants = cvsSentNow === 3;
    if (isThirdCvForApplicants && applicantsTransporter && job.company_email && !job.dont_send_email) {
      const jobLink = `${SITE_BASE_URL}/vakansia/${slugify(job.jobName)}-${job.id}`;
      const applicantsOptions = {
        from: APPLICANTS_MAIL_USER,
        to: (job.company_email || "").trim().split(/[,;]/)[0].trim(),
        subject: `თქვენი ვაკანსია "${job.jobName}" - უკვე ${cvsSentNow} აპლიკანტი`,
        html: APPLICANTS_HTML_TEMPLATE(job.jobName, cvsSentNow, jobLink),
      };
      applicantsTransporter.sendMail(applicantsOptions, (err) => {
        if (err) console.error("Applicants notification error:", err);
      });
    }

    // When 3rd CV is sent to a job, send propositional email from secondary Gmail (skip if dont_send_email)
    if (isThirdCv && hrNotifyTransporter && job.company_email && !job.dont_send_email) {
      const propositionalOptions = {
        from: PROPOSITIONAL_MAIL_USER,
        to: job.company_email,
        subject: `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`,
        html: PROPOSITIONAL_HTML_TEMPLATE(3),
      };
      hrNotifyTransporter.sendMail(propositionalOptions, (err) => {
        if (err) console.error("Propositional email error:", err);
      });
    }

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

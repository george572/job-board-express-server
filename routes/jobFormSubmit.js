/**
 * Simple form submission for jobs (alternative to CV upload).
 * POST /submit-job-form with job_id, applicant_name, applicant_phone?, message?
 */
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

module.exports = (db) => {
const router = express.Router();
router.use(cors());

const MAIL_USER = "info@samushao.ge";
const MAIL_PASS = (process.env.MAIL_PSW || "").trim();

const transporter =
  MAIL_USER && MAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: MAIL_USER, pass: MAIL_PASS },
      })
    : null;

router.post("/", async (req, res) => {
  try {
    const { job_id, applicant_name, applicant_phone, message } = req.body;
    const jobId = parseInt(job_id, 10);

    if (!jobId || isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid job_id" });
    }
    const name = String(applicant_name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "applicant_name is required" });
    }

    const job = await db("jobs").where("id", jobId).first();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    // Handle various DB return types (boolean, 1/0, "t"/"f", "true"/"false")
    const rawVal = job.accept_form_submissions;
    const acceptsForm =
      rawVal === true ||
      rawVal === 1 ||
      rawVal === "t" ||
      String(rawVal || "").toLowerCase() === "true";
    if (!acceptsForm) {
      return res.status(400).json({ error: "This job does not accept form submissions" });
    }
    if (job.expires_at && new Date(job.expires_at) <= new Date()) {
      return res.status(410).json({ error: "This vacancy has expired" });
    }

    const insertPayload = {
      job_id: jobId,
      applicant_name: name,
      applicant_email: "", // email removed from form
      applicant_phone: String(applicant_phone || "").trim() || null,
      message: String(message || "").trim() || null,
    };
    if (req.session?.user?.uid) insertPayload.user_id = req.session.user.uid;
    if (req.visitorId) insertPayload.visitor_id = req.visitorId;

    await db("job_form_submissions").insert(insertPayload);

    if (transporter && job.company_email) {
      const phoneStr = insertPayload.applicant_phone ? `\n<p>ტელეფონი: ${insertPayload.applicant_phone}</p>` : "";
      const msgStr = insertPayload.message ? `\n<p>შეტყობინება: ${insertPayload.message}</p>` : "";
      await transporter.sendMail({
        from: MAIL_USER,
        to: job.company_email,
        subject: `ფორმის განაცხადი - "${job.jobName}"`,
        html: `<p>ახალი განაცხადი ფორმიდან ვაკანსიაზე: "${job.jobName}".</p>
<p>სახელი: ${name}</p>${phoneStr}${msgStr}`,
      });
    }

    return res.json({
      message: "Form submitted successfully",
      job: { id: job.id, jobName: job.jobName },
    });
  } catch (err) {
    console.error("submit-job-form error:", err);
    res.status(500).json({ error: err.message || "An error occurred" });
  }
});

return router;
};

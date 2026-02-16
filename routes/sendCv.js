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

const PROPOSITIONAL_HTML_TEMPLATE = (cvsSent) => `
<p>სალამი!</p>
<p>ბოდიში, ჩვენ დაუკითხავად (მაგრამ კეთილი განზრახვით) დავდეთ თქვენი ვაკანსია ჩვენს საიტზე (<a href="https://samushao.ge">samushao.ge</a>), იმედია არ გაგაბრაზეთ.</p>
<p>საკმაოდ ბევრი ნახვა აქვს განცხადებას, იმის მიუხედავად რომ პრემიუმი არ არის და უკვე <strong>${cvsSent}</strong> რეზიუმე გამოიგზავნა.</p>
<p>თუ თქვენც მოგწონთ ამ რამოდენიმე დღის შედეგები და გინდათ თქვენი ვაკანსია დარჩეს, ჩვენთან განცხადების დადება ფასიანია.</p>
<p>თუ გნებავთ რომ თქვენი განცხადება ავიღოთ, გვითხარით - ჩვენ ბოდიშს მოგიხდით და განცხადებას ავიღებთ.</p>
<p>p.s</p>
<p>პირადი იმეილიდან მიწევს ამ ტექსტის მოწერა, არაპროფესიონალიზმში არ ჩამითვალოთ, ტექნიკური მიზეზებია.</p>
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

    const cvsSentBefore = job.cvs_sent || 0;
    const isFourthCv = cvsSentBefore === 3;

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

    // When 4th CV is sent to a job, send propositional email from secondary Gmail
    if (isFourthCv && hrNotifyTransporter && job.company_email) {
      const propositionalOptions = {
        from: PROPOSITIONAL_MAIL_USER,
        to: job.company_email,
        subject: `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`,
        html: PROPOSITIONAL_HTML_TEMPLATE(4),
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

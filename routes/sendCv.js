const express = require("express");
const knex = require("knex");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { slugify } = require("../utils/slugify");

const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://samushao.ge";

// Load .env from project root (reliable when app is started from any cwd)
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const router = express.Router();
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);
router.use(cors());

const MAIL_USER = "info@samushao.ge";
const MAIL_PASS = (process.env.MAIL_PSW || "").trim();

// Marketing email on 3rd CV – from giorgi@samushao.ge
const MARKETING_MAIL_USER = (process.env.APPLICANTS_MAIL_USER || process.env.MARKETING_MAIL_USER || "").trim();
const MARKETING_MAIL_PASS = (process.env.APPLICANTS_MAIL_PASS || process.env.MARKETING_MAIL_PASS || "").trim().replace(/\s/g, "");

const marketingTransporter =
  MARKETING_MAIL_USER && MARKETING_MAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: MARKETING_MAIL_USER, pass: MARKETING_MAIL_PASS },
      })
    : null;

const PROPOSITIONAL_HTML_TEMPLATE = (cvsSent) => `
<p>სალამი!</p>
<p>გაცნობებთ, რომ თქვენი ვაკანსია რომელიც საჯაროდ ხელმისაწვდომი იყო ინტერნეტში, განვათავსეთ ჩვენს პლატფორმაზე ( samushao.ge ), თუ აღნიშული თქვენთვის მიუღებელია, გთხოვთ შეგვატყობინოთ და განცხადებას წავშლით.</p>
<p>იმის მიუხედავად რომ პრემიუმი არ არის, უკვე <strong>${cvsSent}</strong> რეზიუმე გამოიგზავნა მოკლე დროში.</p>
<p>ეს იმის დასტურია, რომ ჩვენი აუდიტორია თქვენი კომპანიით დაინტერესებულია. თუმცა, ამჟამად თქვენი განცხადება "სტანდარტულ" რეჟიმშია და რამდენიმე დღეში სხვა ვაკანსიების ქვეშ ჩაიკარგება.</p>
<p>რომ არ დაკარგოთ ეს იმპულსი, გირჩევთ Premium სტატუსს, რათა დარჩენილი დროის განმავლობაში მთავარ გვერდზე იყოთ და კიდევ უფრო მეტი ხარისხიანი კანდიდატი მოიზიდოთ.</p>
<p>გსურთ, რომ დაგეხმაროთ გააქტიურებაში?</p>
<p>პატივისცემით,</p>
<p>გიორგი</p>
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

/**
 * Fetches PDF from URL, converts to base64, and asks Gemini if the candidate is a fit for the job.
 * @returns {Promise<boolean>} true if fit, false if not fit
 */
async function assessCandidateFit(job, pdfBase64) {
  const apiKey = process.env.GEMINI_CV_READER_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_CV_READER_API_KEY or GEMINI_API_KEY is missing in .env");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

  const jobDetails = [
    `Job title: ${job.jobName || "N/A"}`,
    `Company: ${job.companyName || "N/A"}`,
    `City: ${job.job_city || "N/A"}`,
    `Experience required: ${job.job_experience || "N/A"}`,
    `Job type: ${job.job_type || "N/A"}`,
    `Address: ${job.job_address || "N/A"}`,
    `Salary: ${job.jobSalary || "N/A"}`,
    "",
    "Job description:",
    job.jobDescription || "",
  ].join("\n");

  const prompt = `You are a recruiter. Assess if the candidate's CV (PDF attached) is a good fit for this job.

Job details:
${jobDetails}

Read the CV/PDF and the job requirements above. Consider: skills, experience level, location preferences, and overall match.

Reply with ONLY one of these two words, nothing else:
- FIT - if the candidate appears suitable for this role
- NOT_FIT - if the candidate does not meet key requirements or is clearly unsuitable`;

  const result = await model.generateContent([
    { text: prompt },
    {
      inlineData: {
        mimeType: "application/pdf",
        data: pdfBase64,
      },
    },
  ]);
  const response = result.response;
  if (!response || !response.text) {
    throw new Error("Empty response from Gemini");
  }
  const text = response.text().trim().toUpperCase();
  if (text.includes("NOT_FIT")) return false;
  return text.includes("FIT");
}

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

    // Already refused for this job? Don't let them retry.
    const previouslyRefused = await db("cv_refusals")
      .where({ user_id, job_id: job.id })
      .first();
    if (previouslyRefused) {
      return res.status(400).json({
        error: "cv_previously_refused",
        message: "თქვენ უკვე სცადეთ აქ გაგზავნა, მაგრამ ვაკანსიის მოთხოვნებს ვერ აკმაყოფილებთ",
      });
    }

    const resume = await db("resumes").where("user_id", user_id).first();
    if (!resume) {
      return res.status(404).json({ error: "Resume not found" });
    }

    const user = await db("users").where("user_uid", user_id).first();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Step A: Fetch PDF from Cloudinary URL
    const pdfResponse = await fetch(resume.file_url);
    if (!pdfResponse.ok) {
      return res.status(502).json({ error: "Failed to fetch resume PDF from storage" });
    }
    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
    const pdfBase64 = pdfBuffer.toString("base64");

    // Step B & C: Pass to Gemini and assess fit
    const isFit = await assessCandidateFit(job, pdfBase64);
    if (!isFit) {
      await db("cv_refusals").insert({ user_id, job_id: job.id });
      return res.status(400).json({
        error: "you are not fit for this role",
        message: "სამწუხაროდ, თქვენი გამოცდილება/უნარები არ შეესაბამება ვაკანსიის მოთხოვნებს",
      });
    }

    const cvsSentBefore = job.cvs_sent || 0;
    const isThirdCv = cvsSentBefore === 2;

    await db("jobs").where("id", job_id).increment("cvs_sent", 1);

    if (!MAIL_PASS) {
      return res.status(500).json({ error: "Email service not configured" });
    }

    const mailOptions = {
      from: MAIL_USER,
      to: job.company_email,
      subject: `ახალი CV - "${job.jobName}"`,
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

    // When 3rd CV is sent, send marketing email from giorgi@samushao.ge
    if (isThirdCv && marketingTransporter && job.company_email && !job.dont_send_email) {
      marketingTransporter.sendMail(
        {
          from: MARKETING_MAIL_USER,
          to: job.company_email,
          subject: `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`,
          html: PROPOSITIONAL_HTML_TEMPLATE(3),
        },
        (err) => {
          if (err) console.error("Marketing email error:", err);
        }
      );
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
      message: "CV is sent successfully",
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

// Complaint: user disagrees with AI assessment, believes they are a good fit
router.post("/complain", async (req, res) => {
  const { job_id, user_id } = req.body;

  try {
    if (!job_id || !user_id) {
      return res.status(400).json({ error: "job_id and user_id are required" });
    }

    const refusal = await db("cv_refusals")
      .where({ user_id, job_id })
      .first();
    if (!refusal) {
      return res.status(400).json({ error: "No refusal found for this user and job" });
    }
    if (refusal.complaint_sent) {
      return res.status(400).json({
        error: "complaint_already_sent",
        message: "თქვენ უკვე გაგზავნეთ სარჩევი",
      });
    }

    const job = await db("jobs").where("id", job_id).first();
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const user = await db("users").where("user_uid", user_id).first();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const resume = await db("resumes").where("user_id", user_id).first();
    const cvLink = resume ? resume.file_url : "N/A";
    const jobUrl = `${SITE_BASE_URL}/vakansia/${slugify(job.jobName || "")}-${job.id}`;

    if (!marketingTransporter) {
      return res.status(500).json({ error: "Email service for complaints is not configured" });
    }

    const html = `
<p>მომხმარებელი აცხადებს, რომ Samushao.ge-ის AI შეფასება არასწორია და ის შესაფერისია ვაკანსიისთვის.</p>
<p><strong>ვაკანსია:</strong> ${job.jobName || "N/A"} (ID: ${job.id})</p>
<p><strong>კომპანია:</strong> ${job.companyName || "N/A"}</p>
<p><strong>ვაკანსიის ბმული:</strong> <a href="${jobUrl}">${jobUrl}</a></p>
<hr>
<p><strong>მომხმარებლის სახელი:</strong> ${user.user_name || "N/A"}</p>
<p><strong>User UID:</strong> ${user_id}</p>
<p><strong>ელ-ფოსტა:</strong> ${user.user_email || "N/A"}</p>
<p><strong>CV ბმული:</strong> <a href="${cvLink}">${cvLink}</a></p>
`;

    await new Promise((resolve, reject) => {
      marketingTransporter.sendMail(
        {
          from: MARKETING_MAIL_USER,
          to: "info@samushao.ge",
          subject: `[გასაჩივრება] მომხმარებელი ფიქრობს რომ შესაფერისია - ${job.jobName || "ვაკანსია"} (ID: ${job.id})`,
          html,
        },
        (err) => {
          if (err) {
            console.error("Complaint email error:", err);
            reject(new Error("Failed to send complaint: " + err.message));
          } else {
            resolve();
          }
        }
      );
    });

    await db("cv_refusals")
      .where({ user_id, job_id })
      .update({ complaint_sent: true });

    return res.json({ message: "Complaint sent successfully" });
  } catch (err) {
    if (res.headersSent) return;
    console.error("send-cv complain error:", err);
    const message = err?.message || err?.error || "An unexpected error occurred";
    return res.status(500).json({ error: message });
  }
});

module.exports = router;

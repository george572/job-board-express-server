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

// Marketing email scheduling: if after 18:30 (server local time), schedule for next day 10:00
function isAfter1830() {
  const now = new Date();
  const hour = now.getHours();
  const min = now.getMinutes();
  return hour > 18 || (hour === 18 && min >= 30);
}

function getNextDay1000() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d;
}

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

  const prompt = `You are an elite Technical Recruiter. Your task is to analyze a candidate's CV (PDF attached) against the Job Description below and provide a Fit Score.

Job details:
${jobDetails}

SCORING LOGIC (Total 100%):
1. Core Technical Skills (50%): Direct experience with the primary tools/languages requested in the JD.
2. Years of Experience (25%): Does the candidate meet or exceed the seniority level?
3. Industry Relevance (15%): Has the candidate worked in a similar sector?
4. Education/Soft Skills (10%): Degree requirements and communication indicators.

CRITICAL RULE: If a "Mandatory" or "Hard Requirement" is missing (e.g. JD asks for Java and candidate has none), the fit_percentage cannot exceed 30%, regardless of other factors.

FINAL DECISION:
- If fit_percentage < 70% → reply NOT_FIT
- If fit_percentage >= 70% → reply FIT

First analyze the CV against the JD using the scoring logic above, then output your final decision. Reply with ONLY one of these two words at the end of your response: FIT or NOT_FIT`;

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

    // Step B & C: Pass to Gemini and assess fit (silent – user always sees success)
    const isFit = await assessCandidateFit(job, pdfBase64);
    if (!isFit) {
      try {
        await db("cv_refusals").insert({ user_id, job_id: job.id });
        await db("users").where("user_uid", user_id).increment("failed_cvs", 1);
      } catch (e) {
        if (e.code === "23505") {
          // Already in cv_refusals (user retried); keep record for admin
        } else throw e;
      }
      // Discard: don't send email, don't add to job_applications; show success to user
      return res.json({
        message: "CV is sent successfully",
        job,
        resume,
        user,
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

    // Third CV marketing – disabled for now
    // if (isThirdCv && marketingTransporter && job.company_email && !job.dont_send_email) {
    //   const companyEmailLower = (job.company_email || "").trim().toLowerCase();
    //   if (companyEmailLower) {
    //     try {
    //       const sendAfter = isAfter1830() ? getNextDay1000() : new Date();
    //       const subject = `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`;
    //       const html = PROPOSITIONAL_HTML_TEMPLATE(3);
    //       await db("new_job_email_queue").insert({
    //         job_id: job.id,
    //         company_email_lower: companyEmailLower,
    //         send_after: sendAfter,
    //         email_type: "third_cv_marketing",
    //         subject,
    //         html,
    //       });
    //       const jobsRouter = require("./jobs");
    //       if (typeof jobsRouter.triggerNewJobEmailQueue === "function") {
    //         jobsRouter.triggerNewJobEmailQueue();
    //       }
    //     } catch (queueErr) {
    //       if (queueErr.code === "23505") {
    //         // unique violation – already queued for this job
    //       } else {
    //         console.error("Third CV marketing queue error:", queueErr.message);
    //       }
    //     }
    //   }
    // }

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

// Complaint endpoint removed – users no longer see refusal, so no appeal UI

module.exports = router;

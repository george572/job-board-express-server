const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");
const { slugify } = require("../utils/slugify");

const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://samushao.ge";

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

let db;
const router = express.Router();
router.use(cors());

const MAIL_USER = "info@samushao.ge";
const MAIL_PASS = (process.env.MAIL_PSW || "").trim();

// Marketing email on 3rd CV – from giorgi@samushao.ge
const APPLICANTS_MAIL_USER = (process.env.APPLICANTS_MAIL_USER || "").trim();
const APPLICANTS_MAIL_PASS = (process.env.APPLICANTS_MAIL_PASS || "")
  .trim()
  .replace(/\s/g, "");

const MARKETING_MAIL_USER = (
  process.env.APPLICANTS_MAIL_USER ||
  process.env.MARKETING_MAIL_USER ||
  ""
).trim();
const MARKETING_MAIL_PASS = (
  process.env.APPLICANTS_MAIL_PASS ||
  process.env.MARKETING_MAIL_PASS ||
  ""
)
  .trim()
  .replace(/\s/g, "");

const applicantsTransporter =
  APPLICANTS_MAIL_USER && APPLICANTS_MAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: APPLICANTS_MAIL_USER, pass: APPLICANTS_MAIL_PASS },
      })
    : null;

const marketingTransporter =
  MARKETING_MAIL_USER && MARKETING_MAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: MARKETING_MAIL_USER, pass: MARKETING_MAIL_PASS },
      })
    : null;

// User vacancy notification – from g.khutiashvili@gmail.com (env: USER_NOTIFICATION_MAIL_USER / USER_NOTIFICATION_MAIL_PASS)
const PROPOSITIONAL_MAIL_USER = (
  process.env.PROPOSITIONAL_MAIL_USER || "g.khutiashvili@gmail.com"
).trim();
const PROPOSITIONAL_MAIL_PASS = (process.env.PROPOSITIONAL_MAIL_PASS || "")
  .trim()
  .replace(/\s/g, "");

const userNotificationTransporter =
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

// Marketing email scheduling: if after 18:30 Georgia time, schedule for next day 10:20 Georgia
const TZ_GEORGIA = "Asia/Tbilisi";
function isAfter1830() {
  const pts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ_GEORGIA,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const hour = parseInt(pts.find((p) => p.type === "hour").value, 10);
  const minute = parseInt(pts.find((p) => p.type === "minute").value, 10);
  return hour > 18 || (hour === 18 && minute >= 30);
}
function getNextDay1020Georgia() {
  const now = new Date();
  const opts = {
    timeZone: TZ_GEORGIA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(now);
  const y = parseInt(parts.find((p) => p.type === "year").value, 10);
  const m = parseInt(parts.find((p) => p.type === "month").value, 10);
  const d = parseInt(parts.find((p) => p.type === "day").value, 10);
  const tomorrow = new Date(y, m - 1, d + 1);
  const y2 = tomorrow.getFullYear();
  const m2 = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const d2 = String(tomorrow.getDate()).padStart(2, "0");
  return new Date(`${y2}-${m2}-${d2}T06:20:00.000Z`); // 10:20 Georgia = 06:20 UTC
}

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

    if (job.expires_at && new Date(job.expires_at) <= new Date()) {
      return res.status(410).json({
        error:
          "This vacancy has expired and is no longer accepting applications",
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

    const cvsSentBefore = job.cvs_sent || 0;
    const isThirdCv = cvsSentBefore === 2;

    await db("jobs").where("id", job_id).increment("cvs_sent", 1);

    if (!MAIL_PASS) {
      return res.status(500).json({ error: "Email service not configured" });
    }

    const mailOptions = {
      from: MAIL_USER,
      to: job.company_email,
      subject: `ახალი CV Samushao.ge-დან - "${job.jobName}"`,
      html: `<p>Samushao.ge-დან ახალი CV გამოიგზავნა თქვენს ვაკანსიაზე: "${job.jobName}".</p>
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

    // Third CV marketing – disabled
    // if (isThirdCv && marketingTransporter && job.company_email && !job.dont_send_email) { ... }

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
      cv_submitted: true,
    });
  } catch (err) {
    if (res.headersSent) return;
    console.error("send-cv error:", err);
    const message =
      err?.message || err?.error || "An unexpected error occurred";
    return res.status(500).json({ error: message });
  }
});

// Endpoint to notify a user about a vacancy that matches their resume (from g.khutiashvili@gmail.com)
router.post("/user-vacancy-email", async (req, res) => {
  const { user_email, job_name, job_link } = req.body || {};

  if (!user_email || !job_name) {
    return res
      .status(400)
      .json({ error: "user_email and job_name are required" });
  }

  if (!userNotificationTransporter) {
    return res.status(500).json({
      error:
        "User notification email is not configured (USER_NOTIFICATION_MAIL_PASS)",
    });
  }

  const link = (job_link || "").trim() || `${SITE_BASE_URL}/`;
  const subject = `ვაკანსია - ${job_name}`;
  const text = `Samushao.ge-ზე არის ვაკანსია, რომელიც შეესაბამება თქვენს რეზიუმეს, ნებას თუ მოგვცემთ თქვენს რეზიუმეს გავუზიარებთ დამსაქმებელს.
  პირობებზე და დეტალებზე შეგიძლიათ დამსაქმებელს გაესაუბროთ როცა დაგიკავშირდებიან;`;
  const mailOptions = {
    from: PROPOSITIONAL_MAIL_USER,
    to: user_email.trim(),
    subject,
    text,
  };

  try {
    await new Promise((resolve, reject) => {
      userNotificationTransporter.sendMail(mailOptions, (err) => {
        if (err) {
          console.error("User vacancy email error:", err);
          reject(
            new Error("Failed to send user vacancy email: " + err.message),
          );
        } else {
          resolve();
        }
      });
    });
    res.json({ ok: true });
  } catch (err) {
    if (res.headersSent) return;
    console.error("user-vacancy-email error:", err);
    res
      .status(500)
      .json({ error: err.message || "Failed to send user vacancy email" });
  }
});

// Endpoint to notify HRs about AI-selected candidates for a specific vacancy
// Also sends emails to all candidates informing them they've been recommended
router.post("/hr-email", async (req, res) => {
  const {
    hr_email,
    company_name,
    job_name,
    job_id,
    job_link,
    last_seen_at,
    users_list,
  } = req.body || {};

  if (!hr_email || !job_name) {
    return res
      .status(400)
      .json({ error: "hr_email and job_name are required" });
  }

  if (!marketingTransporter || !MARKETING_MAIL_USER || !MARKETING_MAIL_PASS) {
    return res
      .status(500)
      .json({ error: "HR email service is not configured" });
  }

  const jobLink =
    (job_link && job_link.trim()) ||
    (job_id && job_name
      ? `${SITE_BASE_URL}/vakansia/${slugify(job_name)}-${job_id}`
      : SITE_BASE_URL);

  const subject = `კანდიდატები ვაკანსია ${job_name}-სთვის.`;

  const list = Array.isArray(users_list) ? users_list : [];
  const usersText =
    list.length > 0
      ? list
          .map((u) => {
            const name = u.user_name ?? u.userName ?? u.name ?? "—";
            const email = u.user_email ?? u.userEmail ?? u.email ?? "—";
            const phone = u.phone ?? "";
            const url = u.cv_url ?? u.cvUrl ?? u.resume_url ?? u.file_url ?? "";
            const summary =
              u.user_summary ?? u.userSummary ?? u.summary ?? "";
            const lines = [`სახელი : ${name}`, `იმეილი : ${email}`];
            if (phone && phone.trim() && phone !== "—")
              lines.push(`ტელეფონი : ${phone}`);
            if (url && url.trim() && url !== "—")
              lines.push(`CV ლინკი : ${url}`);
            if (summary && summary.trim() && summary !== "—")
              lines.push(`AI შეფასება : ${summary}`);
            return lines.join("\n");
          })
          .join("\n\n")
      : "";

  const candidatesBlock =
    list.length === 1 ? `კანდიდატი:\n\n${usersText}\n\n` : list.length > 0 ? `კანდიდატები:\n\n${usersText}\n\n` : "";

  const countLine =
    list.length > 0
      ? `ჩვენ ვიპოვეთ ${list.length} კარგი კანდიდატი თქვენი ვაკანსიისთვის.`
      : "ჩვენ ვიპოვეთ რამდენიმე კარგი კანდიდატი თქვენი ვაკანსიისთვის.";

  const text = `

${countLine}

გაითვალისწინეთ, საუკეთესო კანდიდატები გამოიგზავნა ავტომატურად,
ჩვენ არ ვიცით ეს კანდიდატები დათანხმდებიან თუ არა თქვენთან მუშაობას.
თქვენ თავად უნდა შეეხმიანოთ მათ.

${candidatesBlock}

პატივისცემით,
გიორგი | Samushao.ge`;

  const fromAddr = MARKETING_MAIL_USER || "giorgi@samushao.ge";
  const mailOptions = {
    from: `"Giorgi Khutiashvili - Samushao.ge" <${fromAddr}>`,
    to: hr_email.trim(),
    subject,
    text,
  };

  try {
    await new Promise((resolve, reject) => {
      marketingTransporter.sendMail(mailOptions, (err) => {
        if (err) {
          console.error("HR email sending error:", err);
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Increment job's cvs_sent by number of user data entries sent to HR
    const jobId = job_id ? parseInt(job_id, 10) : NaN;
    if (list.length > 0 && !isNaN(jobId)) {
      try {
        await db("jobs").where("id", jobId).increment("cvs_sent", list.length);
      } catch (incErr) {
        console.error("[hr-email] cvs_sent increment error:", incErr?.message);
      }
    }

    // Also send emails to all candidates informing them they've been recommended
    if (list.length > 0 && applicantsTransporter) {
      const company = (company_name || "").trim() || "კომპანია";
      const candidateSubject = `ჩვენ გავაზიარეთ თქვენი რეზიუმე ვაკანსიისთვის - ${job_name}`;
      const candidateText = `სალამი!

ჩვენ გავუზიარეთ თქვენი CV ვაკანსიისთვის "${job_name}".
დამსაქმებელი შეიძლება დაგიკავშირდეთ პირობებზე და დეტალებზე საუბრისთვის.

პატივისცემით,
Samushao.ge`;

      for (const u of list) {
        const email = (u.user_email ?? u.userEmail ?? u.email ?? "").trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
        try {
          await new Promise((resolve, reject) => {
            applicantsTransporter.sendMail(
              {
                from: `"Samushao.ge" <${APPLICANTS_MAIL_USER}>`,
                to: email,
                subject: candidateSubject,
                text: candidateText,
              },
              (err) => (err ? reject(err) : resolve()),
            );
          });
          console.log(`[hr-email] Sent candidate notification to ${email}`);
        } catch (candErr) {
          console.error(
            `[hr-email] Candidate email failed for ${email}:`,
            candErr?.message,
          );
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    if (res.headersSent) return;
    console.error("hr-email error:", err);
    const msg = err?.message || "Failed to send HR email";
    res.status(500).json({ error: msg });
  }
});

// Complaint endpoint removed – users no longer see refusal, so no appeal UI

module.exports = function (sharedDb) {
  db = sharedDb;
  return router;
};

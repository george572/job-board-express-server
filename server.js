require("dotenv").config();
require("./instrument");
const express = require("express");
const Sentry = require("@sentry/node");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;
const path = require("path");
const knex = require("knex");
const knexfile = require("./knexfile");
const environment = process.env.NODE_ENV || "development";
const db = knex(knexfile[environment]);
const { GoogleGenerativeAI } = require("@google/generative-ai");
const puppeteer = require("puppeteer");
const { slugify, extractIdFromSlug } = require("./utils/slugify");
const { JOBS_LIST_COLUMNS } = require("./utils/jobColumns");
const { parseJobIdsFromCookie } = require("./utils/formSubmittedCookie");
const { parseJobFeedbackIdsFromCookie, setJobFeedbackCookie } = require("./utils/jobFeedbackCookie");
const NodeCache = require("node-cache");

const compression = require("compression");
const app = express();
app.use(compression());
const pageCache = new NodeCache({ stdTTL: 86400 }); // 24 hours
app.locals.pageCache = pageCache;
const port = process.env.PORT || 4000;
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);

// Base URL for SEO (sitemap, robots, canonicals)
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://samushao.ge";

// Georgia timezone for date comparisons – created_at is timestamptz
const TZ_GEORGIA = "Asia/Tbilisi";
const DATE_IN_GEORGIA = `(created_at AT TIME ZONE '${TZ_GEORGIA}')::date`;
const TODAY_IN_GEORGIA = `(NOW() AT TIME ZONE '${TZ_GEORGIA}')::date`;

let lastPremiumExpiryCleanup = 0;
let lastPineconeExpiredJobsCleanup = 0;
const PREMIUM_EXPIRY_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

// Gemini model for CV creator chat (lazy-initialized)
let cvCreatorModel = null;
function getCvCreatorModel() {
  if (cvCreatorModel) return cvCreatorModel;
  const apiKey =
    process.env.GEMINI_CV_READER_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_CV_READER_API_KEY or GEMINI_API_KEY is missing in .env"
    );
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  cvCreatorModel = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
  });
  return cvCreatorModel;
}

/** Build full HTML resume page from cvData (used for server-side PDF) */
function buildCvHtmlFromData(cvData = {}) {
  const escapeHtml = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const fullName =
    ((cvData.name || "") + " " + (cvData.surname || "")).trim() || "";
  const summary = cvData.summary || "";
  const education = cvData.education || "";
  const city = cvData.city || "";
  const rawExperience = cvData.experience;
  const experienceText =
    typeof rawExperience === "string" ? rawExperience : "";
  const skillsArray = String(cvData.skills || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const skillsHtml = skillsArray
    .map((s) => `<div class="skill-item">${escapeHtml(s)}</div>`)
    .join("");

  const languagesArray = Array.isArray(cvData.languages)
    ? cvData.languages.map((lang) => ({
        name: (lang?.name || lang?.language || "").trim(),
        level: (lang?.level || lang?.proficiency || "").trim(),
      }))
    : typeof cvData.languages === "string" && cvData.languages.trim()
      ? cvData.languages
          .split(",")
          .map((s) => ({ name: s.trim(), level: "" }))
      : [];

  const languagesHtml = languagesArray
    .filter((lang) => lang.name)
    .map((lang) => {
      let label = escapeHtml(lang.name);
      if (lang.level) {
        label += " — " + escapeHtml(lang.level);
      }
      return `<div class="skill-item">${label}</div>`;
    })
    .join("");

  const certificatesArray = Array.isArray(cvData.certificates)
    ? cvData.certificates
    : [];

  const certificatesHtml = certificatesArray
    .map((certRaw) => {
      const cert = certRaw || {};
      const title = cert.name || cert.title || "";
      const issuer = cert.issuer || cert.organization || "";
      const year = cert.year || "";
      let line = escapeHtml(title);
      const metaParts = [];
      if (issuer) metaParts.push(escapeHtml(issuer));
      if (year) metaParts.push(escapeHtml(year));
      if (metaParts.length) {
        line += " (" + metaParts.join(", ") + ")";
      }
      return `<div class="skill-item">${line}</div>`;
    })
    .join("");

  const otherInfo = cvData.otherInfo || "";

  const hasSummary = !!(summary && String(summary).trim());
  const hasEducation = !!(education && String(education).trim());

  const jobsSource = Array.isArray(cvData.jobs)
    ? cvData.jobs
    : Array.isArray(cvData.experience)
      ? cvData.experience
      : null;
  let jobsHtml = "";
  if (jobsSource && jobsSource.length) {
    jobsHtml = jobsSource
      .map((j) => {
        j = j || {};
        const company = j.company || "";
        const position = j.position || "";
        const start = j.start_date || "";
        const end = j.end_date || "";
        const jobSummary = j.summary || "";
        let duties = j.duties;
        let dutySource = "";
        if (Array.isArray(duties)) dutySource = duties.join("\n");
        else if (typeof duties === "string") dutySource = duties;
        else if (duties != null) dutySource = String(duties);
        let dutyLines = (dutySource || "")
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean);
        if (!dutyLines.length && jobSummary) dutyLines = [jobSummary];
        let bullets = dutyLines
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join("");
        if (!bullets && experienceText) {
          bullets = `<li>${escapeHtml(experienceText)}</li>`;
        }
        const dateRange =
          start || end
            ? `${escapeHtml(start)}${
                end ? " — " + escapeHtml(end) : ""
              }`
            : "";
        return `
          <div class="job">
            <div class="job-header">
              <span class="job-company">${escapeHtml(
                company || "კომპანია"
              )}</span>
              <span class="job-location"></span>
            </div>
            <div class="job-sub">
              <span class="job-title">${escapeHtml(position || "")}</span>
              <span class="job-dates">${dateRange}</span>
            </div>
            <ul class="job-bullets">${bullets}</ul>
          </div>
        `;
      })
      .join("");
  } else if (experienceText) {
    jobsHtml = `
      <div class="job">
        <div class="job-header">
          <span class="job-company">გამოცდილება</span>
          <span class="job-location"></span>
        </div>
        <div class="job-sub">
          <span class="job-title"></span>
          <span class="job-dates"></span>
        </div>
        <ul class="job-bullets"><li>${escapeHtml(
          experienceText
        )}</li></ul>
      </div>
    `;
  }

  const hasJobsSection = !!(jobsHtml && String(jobsHtml).trim());
  const hasSkills = !!(skillsHtml && String(skillsHtml).trim());
  const hasLanguages = !!(languagesHtml && String(languagesHtml).trim());
  const hasCertificates = !!(certificatesHtml && String(certificatesHtml).trim());
  const hasOtherInfo = !!(otherInfo && String(otherInfo).trim());

  const primaryPosition =
    jobsSource &&
    jobsSource[0] &&
    typeof jobsSource[0] === "object" &&
    jobsSource[0].position
      ? jobsSource[0].position
      : "";
  const profession = cvData.profession || "";
  const badgeText =
    profession || primaryPosition || (summary ? summary.slice(0, 80) : "პროფესიული რეზიუმე");

  // Theme color (user favorite); fall back to default green
  let themeColor = (cvData.themeColor || cvData.favoriteColor || cvData.color || "#8fbc8f").trim();
  const lower = themeColor.toLowerCase();
  if (!themeColor) themeColor = "#8fbc8f";
  const badgeTextColor =
    lower === "#ffffff" || lower === "#fff" || lower === "white" ? "#111111" : "#ffffff";

  const summarySectionHtml = hasSummary
    ? [
        '    <div class="section">',
        '      <div class="section-header">',
        '        <div class="section-icon">',
        '          <svg viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>',
        "        </div>",
        '        <span class="section-title">მოკლე აღწერა</span>',
        "      </div>",
        `      <p class="summary-text">${escapeHtml(summary || "")}</p>`,
        "    </div>",
      ].join("")
    : "";

  const workSectionHtml = hasJobsSection
    ? [
        '    <div class="section">',
        '      <div class="section-header">',
        '        <div class="section-icon">',
        '          <svg viewBox="0 0 24 24"><path d="M20 6h-2.18c.07-.44.18-.88.18-1.34C18 2.54 15.96.5 13.46.5c-1.36 0-2.5.56-3.46 1.44C9.04 1.06 7.9.5 6.54.5 4.04.5 2 2.54 2 4.66c0 .46.11.9.18 1.34H0v14c0 1.1.9 2 2 2h20c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-7.46-3.5c1.29 0 2.46 1.06 2.46 2.16 0 .44-.07.88-.18 1.34H12V4.68c.29-.94.84-2.18 2.54-2.18.37 0 .93.11.93.11zM7 2.5c1.7 0 2.25 1.24 2.54 2.18V6.5H6.18c-.11-.46-.18-.9-.18-1.34C6 3.56 7.04 2.5 7.04 2.5H7zM2 8h20v4H2V8zm0 12v-6h8v2h4v-2h8v6H2z"/></svg>',
        "        </div>",
        '        <span class="section-title">სამუშაო გამოცდილება</span>',
        "      </div>",
        jobsHtml,
        "    </div>",
      ].join("")
    : "";

  const educationSectionHtml = hasEducation
    ? [
        '    <div class="section">',
        '      <div class="section-header">',
        '        <div class="section-icon">',
        '          <svg viewBox="0 0 24 24"><path d="M12 3L1 9l4 2.18V15c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-3.82L23 9 12 3zm6 12H6v-3.27l6 3.27 6-3.27V15zm-6-5.18L4.53 9 12 5.18 19.47 9 12 9.82z"/></svg>',
        "        </div>",
        '        <span class="section-title">განათლება</span>',
        "      </div>",
        `      <div class="edu-school">${escapeHtml(education || "")}</div>`,
        "    </div>",
      ].join("")
    : "";

  const skillsSectionHtml = hasSkills
    ? [
        '    <div class="sidebar-section">',
        '      <div class="sidebar-title">',
        '        <div class="icon-box">',
        '          <svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
        "        </div>",
        "        უნარები",
        "      </div>",
        skillsHtml,
        "    </div>",
      ].join("")
    : "";

  const languagesSectionHtml = hasLanguages
    ? [
        '    <div class="sidebar-section">',
        '      <div class="sidebar-title">',
        '        <div class="icon-box">',
        '          <svg viewBox="0 0 24 24"><path d="M4 4h16v2H5v3H3V5c0-.6.4-1 1-1zm3 5h14c.6 0 1 .4 1 1v9c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1v-9c0-.6.4-1 1-1zm7 2l-3 7h2l.6-1.5h2.8L18 18h2l-3-7h-2zm-1 4l.9-2.2L15.8 15H13z"/></svg>',
        "        </div>",
        "        ენები",
        "      </div>",
        languagesHtml,
        "    </div>",
      ].join("")
    : "";

  const certificatesSectionHtml = hasCertificates
    ? [
        '    <div class="section">',
        '      <div class="section-header">',
        '        <div class="section-icon">',
        '          <svg viewBox="0 0 24 24"><path d="M12 2l3.5 7.1 7.8 1.1-5.6 5.4 1.3 7.7L12 18.8 5 21.3l1.3-7.7-5.6-5.4 7.8-1.1z"/></svg>',
        "        </div>",
        '        <span class="section-title">სერტიფიკატები</span>',
        "      </div>",
        certificatesHtml,
        "    </div>",
      ].join("")
    : "";

  const otherInfoSectionHtml = hasOtherInfo
    ? [
        '    <div class="section">',
        '      <div class="section-header">',
        '        <div class="section-icon">',
        '          <svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 5.6 2 10c0 2.5 1.5 4.7 3.8 6.2L5 22l4.4-2.4c.8.1 1.5.2 2.3.2 5.5 0 10-3.6 10-8s-4.5-8-10-8zm1 12h-2v-2h2v2zm0-4h-2V6h2v4z"/></svg>',
        "        </div>",
        '        <span class="section-title">სხვა ინფორმაცია</span>',
        "      </div>",
        `      <p class="summary-text">${escapeHtml(otherInfo || "")}</p>`,
        "    </div>",
      ].join("")
    : "";

  return (
    "<!DOCTYPE html>" +
    '<html lang="ka">' +
    "<head>" +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    `<title>${escapeHtml(fullName || "რეზიუმე")}</title>` +
    '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Georgian:wght@400;600;700&family=Raleway:wght@400;600;700;800&display=swap" rel="stylesheet">' +
    "<style>" +
    "*{margin:0;padding:0;box-sizing:border-box;}" +
    "body{font-family:'Raleway','Noto Sans Georgian',sans-serif;background:#ffffff;margin:0;padding:0;}" +
    ".page{background:#fff;width:100%;min-height:100vh;display:flex;}" +
    ".sidebar{width:260px;min-width:260px;background:#f7f7f7;padding:40px 28px;border-right:1px solid #eee;}" +
    ".sidebar-section{margin-bottom:36px;}" +
    ".sidebar-title{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#2d2d2d;margin-bottom:18px;}" +
    `.icon-box{width:32px;height:32px;background:${themeColor};border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}` +
    ".icon-box svg{width:16px;height:16px;fill:#fff;}" +
    ".contact-item{display:flex;align-items:flex-start;gap:10px;margin-bottom:14px;font-size:13px;color:" + themeColor + ";line-height:1.4;}" +
    `.contact-item svg{width:16px;height:16px;fill:${themeColor};flex-shrink:0;margin-top:1px;}` +
    ".skill-item{display:flex;align-items:center;gap:8px;font-size:13px;color:#444;margin-bottom:10px;}" +
    '.skill-item::before{content:"•";color:#5a8a5a;font-size:16px;}' +
    ".main{flex:1;padding:40px 44px;}" +
    ".name{font-size:42px;font-weight:800;color:#1a1a1a;letter-spacing:-1px;line-height:1;margin-bottom:16px;text-transform:capitalize;}" +
    `.title-badge{display:inline-block;background:${themeColor};color:${badgeTextColor};font-family:'Noto Sans Georgian',sans-serif;font-size:14px;font-weight:600;padding:10px 24px;border-radius:6px;margin-bottom:36px;width:100%;text-align:left;}` +
    ".section{margin-bottom:34px;}" +
    ".section-header{display:flex;align-items:center;gap:12px;margin-bottom:14px;border-bottom:1px solid #eee;padding-bottom:10px;}" +
    `.section-icon{width:34px;height:34px;background:${themeColor};border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}` +
    ".section-icon svg{width:18px;height:18px;fill:#fff;}" +
    ".section-title{font-size:14px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#1a1a1a;}" +
    ".summary-text{font-size:13.5px;color:#444;line-height:1.7;}" +
    ".job{margin-bottom:18px;}" +
    ".job-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px;}" +
    ".job-company{font-family:'Noto Sans Georgian',sans-serif;font-weight:700;font-size:14px;color:#2d2d2d;}" +
    ".job-location{font-family:'Noto Sans Georgian',sans-serif;font-size:13px;color:#666;}" +
    ".job-sub{display:flex;justify-content:space-between;margin-bottom:10px;}" +
    ".job-title{font-family:'Noto Sans Georgian',sans-serif;font-size:13px;color:#555;}" +
    ".job-dates{font-size:13px;color:#666;}" +
    ".job-bullets{list-style:none;padding:0;}" +
    ".job-bullets li{font-size:13.5px;color:#444;line-height:1.6;padding-left:16px;position:relative;margin-bottom:6px;}" +
    '.job-bullets li::before{content:"•";position:absolute;left:0;color:#5a8a5a;font-size:16px;line-height:1.4;}' +
    ".edu-school{font-family:'Noto Sans Georgian',sans-serif;font-weight:700;font-size:14px;color:#2d2d2d;}" +
    "</style>" +
    "</head>" +
    "<body>" +
    '<div class="page">' +
    '  <div class="sidebar">' +
    '    <div class="sidebar-section">' +
    '      <div class="sidebar-title">' +
    '        <div class="icon-box">' +
    '          <svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>' +
    "        </div>" +
    "        საკონტაქტო ინფორმაცია" +
    "      </div>" +
    '      <div class="contact-item">' +
    '        <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5 14.5 7.62 14.5 9 13.38 11.5 12 11.5z"/></svg>' +
    `        ${escapeHtml(city || "")}` +
    "      </div>" +
    '      <div class="contact-item">' +
    '        <svg viewBox="0 0 24 24"><path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/></svg>' +
    `        ${escapeHtml(cvData.phone || "")}` +
    "      </div>" +
    '      <div class="contact-item">' +
    '        <svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>' +
    `        ${escapeHtml(cvData.email || "")}` +
    "      </div>" +
    "    </div>" +
    '    <div class="sidebar-section">' +
    '      <div class="sidebar-title">' +
    '        <div class="icon-box">' +
    '          <svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>' +
    "        </div>" +
    "        Skills" +
    "      </div>" +
    skillsHtml +
    "    </div>" +
    languagesSectionHtml +
    "  </div>" +
    '  <div class="main">' +
    `    <h1 class="name">${escapeHtml(fullName || "")}</h1>` +
    `    <div class="title-badge">${escapeHtml(badgeText || "")}</div>` +
    summarySectionHtml +
    workSectionHtml +
    educationSectionHtml +
    certificatesSectionHtml +
    otherInfoSectionHtml +
    "  </div>" +
    "</div>" +
    "</body></html>"
  );
}

/** Today's date in Georgia (YYYY-MM-DD) for premium expiry. 0 days left = expired. */
function getTodayGeorgiaYYYYMMDD() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ_GEORGIA });
}

/** If premium_until is set and 0 days left (or past), treat job as regular for display and optionally persist. */
function normalizeJobPremiumByDaysLeft(job) {
  if (!job || !["premium", "premiumPlus"].includes(job.job_premium_status)) return;
  const until = job.premium_until;
  if (until == null) return;
  const untilStr =
    typeof until === "string"
      ? until.slice(0, 10)
      : until instanceof Date
        ? until.toISOString().slice(0, 10)
        : null;
  if (!untilStr) return;
  const todayGeorgia = getTodayGeorgiaYYYYMMDD();
  if (untilStr <= todayGeorgia) {
    job.job_premium_status = "regular";
  }
}

async function runPremiumExpiryCleanup() {
  if (Date.now() - lastPremiumExpiryCleanup < PREMIUM_EXPIRY_CLEANUP_INTERVAL_MS) return;
  lastPremiumExpiryCleanup = Date.now();
  try {
    // 0 days left = premium_until <= today (Georgia). Expired = set to regular.
    const result = await db.raw(
      `UPDATE jobs SET job_premium_status = 'regular'
       WHERE job_premium_status IN ('premium','premiumPlus')
       AND (
         premium_until IS NULL
         OR premium_until <= (NOW() AT TIME ZONE 'Asia/Tbilisi')::date
       )`
    );
    const n = result?.rowCount ?? result?.[1] ?? 0;
    if (n > 0) {
      console.log("[premium expiry] Cleared", n, "expired premium job(s)");
      if (app.locals.pageCache) app.locals.pageCache.flushAll();
      if (app.locals.relatedJobsCache) app.locals.relatedJobsCache.flushAll();
    }
  } catch (e) {
    console.error("premium expiry cleanup error:", e?.message);
  }
}

async function runExpiredJobsPineconeCleanup() {
  if (Date.now() - lastPineconeExpiredJobsCleanup < PREMIUM_EXPIRY_CLEANUP_INTERVAL_MS) return;
  if (!(process.env.PINECONE_API_KEY || "").trim()) return;
  lastPineconeExpiredJobsCleanup = Date.now();
  try {
    const { deleteJobs } = require("./services/pineconeJobs");
    const rows = await db("jobs")
      .whereNotNull("expires_at")
      .where("expires_at", "<", db.fn.now())
      .select("id");
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await deleteJobs(ids);
      console.log("[pinecone] Removed", ids.length, "expired job(s) from jobs index");
    }
  } catch (e) {
    console.error("pinecone expired jobs cleanup error:", e?.message);
  }
}

// Sentinel category ID for personalized recommendations (no jobs have this category_id)
const RECOMMENDED_CATEGORY_ID = 9999;

const cvFitCache = require("./services/cvFitCache");

/**
 * Get personalized job recommendations based on visitor's past clicks.
 * Picks the top N jobs ranked by relevance: category match + title keyword overlap.
 * Excludes already-clicked jobs. Sort: relevance DESC, then premium/prioritized, then created_at.
 */
async function getRecommendedJobs(db, visitorId, opts = {}) {
  const {
    limit = 20,
    offset = 0,
    min_salary,
    job_experience,
    job_type,
    work_mode,
    job_city,
    searchQuery,
    userUid,
  } = opts;

  if (!visitorId && !userUid) {
    return { jobs: [], total: 0 };
  }

  const IGNORED_CATEGORY_OTHER = 19;
  const STOPWORDS = new Set(
    [
      "მენეჯერი", "სპეციალისტი", "ასისტენტი", "ოპერატორი", "აგენტი",
      "წარმომადგენელი", "კონსულტანტი", "ანალიტიკოსი", "ექსპერტი",
      "შემსრულებელი", "მუშაკი", "თანამშრომელი", "ვაკანსია", "სამუშაო",
    ].map((x) => x.toLowerCase())
  );
  const extractWords = (titles) =>
    titles
      .flatMap((t) => (t || "").trim().split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase())))
      .slice(0, 12);

  let clickedJobIdsToExclude = [];
  let clickedCategoryIds = [];
  let titleWords = [];
  let highVisitCategoryIds = [];
  let clicks = [];
  if (visitorId) {
    clicks = await db("visitor_job_clicks")
      .where("visitor_id", visitorId)
      .select("job_id", "category_id", "job_title", "from_recommended");
    if (clicks && clicks.length > 0) {
      clickedJobIdsToExclude = [...new Set(
        clicks.filter((c) => !c.from_recommended).map((c) => c.job_id).filter(Boolean)
      )];
      clickedCategoryIds = [...new Set(clicks.map((c) => c.category_id).filter((n) => n != null && !isNaN(n)))];
      titleWords = extractWords(clicks.map((c) => c.job_title));
      const categoryVisitCounts = {};
      clicks.forEach((c) => {
        if (c.category_id != null && !isNaN(c.category_id)) {
          categoryVisitCounts[c.category_id] = (categoryVisitCounts[c.category_id] || 0) + 1;
        }
      });
      highVisitCategoryIds = Object.keys(categoryVisitCounts)
        .filter((cid) => categoryVisitCounts[cid] >= 3)
        .map((n) => parseInt(n, 10));
    }
  }

  let cvJobIds = [];
  let cvCategoryIds = [];
  let cvTitleWords = [];
  let cvApplicationsQb = db("job_applications as ja")
    .join("jobs as j", "j.id", "ja.job_id")
    .where("j.job_status", "approved")
    .whereRaw("(j.expires_at IS NULL OR j.expires_at > NOW())")
    .select("ja.job_id", "j.category_id", "j.jobName");
  if (visitorId && userUid) {
    cvApplicationsQb = cvApplicationsQb.andWhere((qb) =>
      qb.where("ja.visitor_id", visitorId).orWhere("ja.user_id", userUid)
    );
  } else if (visitorId) {
    cvApplicationsQb = cvApplicationsQb.where("ja.visitor_id", visitorId);
  } else if (userUid) {
    cvApplicationsQb = cvApplicationsQb.where("ja.user_id", userUid);
  } else {
    cvApplicationsQb = cvApplicationsQb.whereRaw("1=0");
  }
  const cvApplications = await cvApplicationsQb;
  if (cvApplications && cvApplications.length > 0) {
    cvJobIds = [...new Set(cvApplications.map((a) => a.job_id).filter(Boolean))];
    cvCategoryIds = [...new Set(cvApplications.map((a) => a.category_id).filter((n) => n != null && !isNaN(n)))];
    cvTitleWords = extractWords(cvApplications.map((a) => a.jobName));
  }

  const appliedJobIdsToExclude = cvJobIds;
  // Always exclude applied jobs. For clicked jobs: don't exclude if premium/premiumPlus/prioritize (show in recommendations)
  let allExclude = [...appliedJobIdsToExclude];
  if (clickedJobIdsToExclude.length > 0) {
    const premiumRows = await db("jobs")
      .whereIn("id", clickedJobIdsToExclude)
      .where((qb) =>
        qb.whereIn("job_premium_status", ["premium", "premiumPlus"]).orWhere("prioritize", true).orWhere("prioritize", 1)
      )
      .select("id");
    const premiumOrPrioritizedIds = (premiumRows || []).map((r) => r.id);
    const premiumSet = new Set(premiumOrPrioritizedIds || []);
    const clickedToExclude = clickedJobIdsToExclude.filter((id) => !premiumSet.has(id));
    allExclude = [...new Set([...allExclude, ...clickedToExclude])];
  }
  const allCategoryIds = [...new Set([...clickedCategoryIds, ...cvCategoryIds])];
  const kwWords = titleWords.slice(0, 8);
  const cvKwWords = cvTitleWords.slice(0, 8);

  if (allCategoryIds.length === 0 && kwWords.length === 0 && cvKwWords.length === 0 && highVisitCategoryIds.length === 0) {
    return { jobs: [], total: 0 };
  }

  let baseQuery = db("jobs")
    .select(...JOBS_LIST_COLUMNS)
    .where("job_status", "approved")
    .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
    .whereNot("category_id", IGNORED_CATEGORY_OTHER)
    .whereNotIn("id", allExclude.length > 0 ? allExclude : [0]);

  if (allCategoryIds.length > 0 || kwWords.length > 0 || cvKwWords.length > 0 || highVisitCategoryIds.length > 0) {
    baseQuery = baseQuery.andWhere((qb) => {
      let first = true;
      if (allCategoryIds.length > 0) {
        qb.whereIn("category_id", allCategoryIds);
        first = false;
      }
      if (highVisitCategoryIds.length > 0) {
        const extraCat = highVisitCategoryIds.filter((cid) => !allCategoryIds.includes(cid));
        if (extraCat.length > 0) {
          if (first) {
            qb.whereIn("category_id", highVisitCategoryIds);
            first = false;
          } else {
            qb.orWhereIn("category_id", highVisitCategoryIds);
          }
        }
      }
      for (const word of kwWords) {
        const escaped = "%" + String(word).replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
        if (first) {
          qb.whereRaw('"jobName" ILIKE ?', [escaped]);
          first = false;
        } else {
          qb.orWhereRaw('"jobName" ILIKE ?', [escaped]);
        }
      }
      for (const word of cvKwWords) {
        if (kwWords.includes(word)) continue;
        const escaped = "%" + String(word).replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
        if (first) {
          qb.whereRaw('"jobName" ILIKE ?', [escaped]);
          first = false;
        } else {
          qb.orWhereRaw('"jobName" ILIKE ?', [escaped]);
        }
      }
    });
  }

  if (min_salary) {
    const salaries = (Array.isArray(min_salary) ? min_salary : [min_salary]).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    if (salaries.length > 0) baseQuery = baseQuery.where("jobSalary_min", ">=", Math.min(...salaries));
  }
  if (job_experience) {
    const exp = Array.isArray(job_experience) ? job_experience : [job_experience];
    if (exp.length > 0) baseQuery = baseQuery.whereIn("job_experience", exp);
  }
  if (job_type) {
    const types = Array.isArray(job_type) ? job_type : [job_type];
    if (types.length > 0) baseQuery = baseQuery.whereIn("job_type", types);
  }
  if (work_mode) {
    const modes = Array.isArray(work_mode) ? work_mode : [work_mode];
    if (modes.length > 0) baseQuery = baseQuery.whereIn("work_mode", modes);
  }
  if (job_city) {
    const cities = Array.isArray(job_city) ? job_city : [job_city];
    if (cities.length > 0) baseQuery = baseQuery.whereIn("job_city", cities);
  }
  if (searchQuery && String(searchQuery).trim()) {
    const term =
      "%" + String(searchQuery).trim().replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
    baseQuery = baseQuery.andWhereRaw(
      '("jobName" ILIKE ? OR "companyName" ILIKE ? OR COALESCE("jobDescription", \'\') ILIKE ?)',
      [term, term, term]
    );
  }

  const candidates = await baseQuery.limit(500);

  const cvTitles = [...new Set(cvApplications.map((a) => (a.jobName || "").trim()).filter((t) => t.length >= 5))];
  const clickTitles = [...new Set(clicks.map((c) => (c.job_title || "").trim()).filter((t) => t.length >= 5))];

  function scoreJob(job) {
    let score = 0;
    let keywordMatches = 0;
    if (clickedCategoryIds.length > 0 && clickedCategoryIds.includes(job.category_id)) score += 2;
    if (cvCategoryIds.length > 0 && cvCategoryIds.includes(job.category_id)) score += 4;
    if (highVisitCategoryIds.length > 0 && highVisitCategoryIds.includes(job.category_id)) score += 3;
    const jobNameLower = (job.jobName || "").toLowerCase();
    for (const phrase of cvTitles.slice(0, 5)) {
      if (phrase.length >= 6 && jobNameLower.includes(phrase.toLowerCase())) {
        score += 5;
        keywordMatches += 1;
      }
    }
    for (const phrase of clickTitles.slice(0, 5)) {
      if (phrase.length >= 6 && jobNameLower.includes(phrase.toLowerCase())) {
        score += 3;
        keywordMatches += 1;
      }
    }
    for (const word of kwWords) {
      if (jobNameLower.includes(word.toLowerCase())) {
        score += 1;
        keywordMatches += 1;
      }
    }
    for (const word of cvKwWords) {
      if (jobNameLower.includes(word.toLowerCase())) {
        score += 3;
        keywordMatches += 1;
      }
    }
    return { score, keywordMatches };
  }

  const hasKeywordSignal = kwWords.length > 0 || cvKwWords.length > 0;
  const scored = candidates
    .map((j) => ({ job: j, ...scoreJob(j) }))
    .filter((s) => {
      if (s.score < 2) return false;
      const isHighVisitCategory = highVisitCategoryIds.length > 0 && highVisitCategoryIds.includes(s.job.category_id);
      if (hasKeywordSignal && s.keywordMatches === 0 && !isHighVisitCategory) return false;
      return true;
    });
  // Sort: premium+prioritize > premium only > prioritize only > regular; within premium: premiumPlus > premium
  const sortRank = (j) => {
    const premium = ["premium", "premiumPlus"].includes(j.job_premium_status);
    const prior = j.prioritize === true || j.prioritize === 1;
    if (premium && prior) return j.job_premium_status === "premiumPlus" ? 0 : 1;
    if (premium) return j.job_premium_status === "premiumPlus" ? 2 : 3;
    if (prior) return 4;
    return 5;
  };
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aR = sortRank(a.job);
    const bR = sortRank(b.job);
    if (aR !== bR) return aR - bR;
    return new Date(b.job.created_at) - new Date(a.job.created_at);
  });

  const seenKey = new Set();
  const deduped = [];
  for (const { job } of scored) {
    const key = String(job.jobName || "").trim() + "|" + String(job.companyName || "").trim();
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    deduped.push(job);
  }

  const total = deduped.length;
  let jobs = deduped.slice(offset, offset + limit);

  // Premium (not prioritized) in second position: move first premium job to slot 2 (index 1)
  if (jobs.length >= 2) {
    const isPremium = (j) => ["premium", "premiumPlus"].includes(j.job_premium_status);
    const premiumIdx = jobs.findIndex((j) => isPremium(j));
    if (premiumIdx > 1) {
      const [first, , ...rest] = jobs;
      const premium = jobs[premiumIdx];
      const restWithoutPremium = jobs.filter((_, i) => i !== 0 && i !== premiumIdx);
      jobs = [first, premium, ...restWithoutPremium];
    }
  }

  return { jobs, total };
}

// Behind Fly/Heroku we must trust the proxy so secure cookies work
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// Session: Postgres store so sessions work across multiple machines (load balancer). MUST run before HR (uses req.session) and before page cache.
const knexConfig = knexfile[environment];
const sessionStore = process.env.DATABASE_URL
  ? new pgSession({
      conString: process.env.DATABASE_URL,
      tableName: "session",
      createTableIfMissing: true,
    })
  : knexConfig?.connection
    ? new pgSession({
        conObject: knexConfig.connection,
        tableName: "session",
        createTableIfMissing: true,
      })
    : undefined;
const sessionOptions = {
  store: sessionStore,
  resave: false,
  secret: process.env.SESSION_SECRET || "askmdaksdhjkqjqkqkkq1",
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: "lax",
    // No domain = host-only cookie; works reliably with proxies & Google auth
  },
};
app.use(session(sessionOptions));

// Body parsers – MUST run before HR router (login/register POST need req.body)
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// hr.samushao.ge – serve HR app at root. MUST run before page cache (which serves cached homepage for GET /).
// Other hosts: redirect /hr to hr.samushao.ge
const hrRouter = require("./routes/hrDashboard")(db);
app.use((req, res, next) => {
  if (req.hostname === "hr.samushao.ge" || req.hostname === "hr.localhost") {
    return hrRouter(req, res, next);
  }
  if (req.path === "/hr" || req.path.startsWith("/hr/")) {
    const path = req.path.replace(/^\/hr\/?/, "/") || "/";
    const q = req.originalUrl.includes("?") ? "?" + req.originalUrl.split("?")[1] : "";
    return res.redirect(301, "https://hr.samushao.ge" + path + q);
  }
  next();
});

// Fast path: serve cached HTML for anonymous visitors
// Skips 3 sequential DB round-trips (~15-30ms) for every cached anonymous page view
app.use(async (req, res, next) => {
  if (req.method !== "GET") return next();
  if (hasCookie(req, "connect.sid")) return next();
  const pathOnly = req.path;
  if (pathOnly === "/" || CACHEABLE_PATHS.test(pathOnly)) {
    const key = req.originalUrl || req.url;
    const cached = pageCache.get(key);
    if (cached) {
      const jobMatch = pathOnly.match(/^\/vakansia\/(.+)$/);
      if (jobMatch) {
        const jobIdRaw = extractIdFromSlug(jobMatch[1]);
        const jobId = jobIdRaw ? parseInt(jobIdRaw, 10) : null;
        if (jobId && !isNaN(jobId)) {
          // If job was demoted or 0 days left for premium, invalidate cache so next request gets correct badge
          try {
            const row = await db("jobs").where({ id: jobId }).select("job_premium_status", "premium_until").first();
            if (row) {
              const isRegular = row.job_premium_status === "regular";
              const zeroDaysLeft =
                row.premium_until != null &&
                ["premium", "premiumPlus"].includes(row.job_premium_status) &&
                String(row.premium_until).slice(0, 10) <= getTodayGeorgiaYYYYMMDD();
              if (isRegular || zeroDaysLeft) {
                pageCache.del(key);
                return next();
              }
            }
          } catch (e) {
            /* continue and serve cached */
          }
          db.raw("UPDATE jobs SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?", [jobId]).catch(() => {});
          const vidMatch = (req.headers.cookie || "").match(/\bvid=([^;]+)/);
          const visitorId = vidMatch ? decodeURIComponent(vidMatch[1]) : null;
          if (visitorId) {
            db("jobs").where({ id: jobId }).select("jobSalary", "jobName", "category_id", "job_city", "job_experience", "job_type").first().then(async (job) => {
              if (!job) return;
              const catName = await getCategoryName(job.category_id);
              return db("visitor_job_clicks").insert({
                visitor_id: visitorId,
                job_id: jobId,
                job_salary: job.jobSalary || null,
                job_title: job.jobName || null,
                category_id: job.category_id || null,
                job_category_name: catName,
                job_city: job.job_city || null,
                job_experience: job.job_experience || null,
                job_type: job.job_type || null,
                from_recommended: req.query.from === "recommended",
              });
            }).catch(() => {});
          }
        }
      }
      return res.set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache" }).send(cached);
    }
  }
  next();
});

// res.locals middleware
const ENLISTED_FB_COOKIE = "enlisted_fb";
const NO_CV_BANNER_COOKIE = "no_cv_banner_dismissed";
function hasCookie(req, name) {
  const raw = req?.headers?.cookie || "";
  return new RegExp(`\\b${name}=([^;]+)`).test(raw);
}
function hasEnlistedFbCookie(req) {
  return hasCookie(req, ENLISTED_FB_COOKIE);
}
app.use((req, res, next) => {
  res.locals.user = req.session?.user || null;
  res.locals.enlistedInFb = hasCookie(req, ENLISTED_FB_COOKIE);
  res.locals.showNoCvBanner = !req.session?.user && !hasCookie(req, NO_CV_BANNER_COOKIE);
  next();
});

const { visitorMiddleware } = require("./middleware/visitor");
app.use(visitorMiddleware(db, extractIdFromSlug));

// After visitor: upgrade enlistedInFb from DB if user/visitor has interacted (cached)
const enlistedFbCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });
app.use(async (req, res, next) => {
  if (res.locals.enlistedInFb) return next();
  const userId = req.session?.user?.uid;
  const visitorId = req.visitorId;
  if (!userId && !visitorId) return next();
  const cacheKey = `fb_${userId || ""}_${visitorId || ""}`;
  const cached = enlistedFbCache.get(cacheKey);
  if (cached !== undefined) {
    if (cached) res.locals.enlistedInFb = true;
    return next();
  }
  try {
    let q = db("enlisted_in_fb");
    if (userId && visitorId) {
      q = q.whereRaw("(user_id = ? OR visitor_id = ?)", [userId, visitorId]);
    } else if (userId) {
      q = q.where("user_id", userId);
    } else {
      q = q.where("visitor_id", visitorId);
    }
    const found = await q.first();
    enlistedFbCache.set(cacheKey, !!found);
    if (found) res.locals.enlistedInFb = true;
  } catch (e) {
    /* ignore */
  }
  next();
});

// Page cache: serve cached HTML for anonymous visitors (24h)
// Runs after visitor middleware so req.visitorId is set for job view tracking on cache hits
const CACHEABLE_PATHS = /^\/(vakansia\/[^/]+|kvelaze-motkhovnadi-vakansiebi|kvelaze-magalanazgaurebadi-vakansiebi|dgevandeli-vakansiebi|rekomendebuli-vakansiebi|vakansiebi-cv-gareshe|vakansiebi-shentvis|privacy-policy|terms-of-use|pricing)(\?.*)?$/;
app.use(async (req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.session?.user) return next();
  const pathOnly = req.path;
  if (pathOnly === "/" || CACHEABLE_PATHS.test(pathOnly)) {
    const key = req.originalUrl || req.url;
    const cached = pageCache.get(key);
    if (cached) {
      // For job detail pages: if job was demoted from premium, invalidate cache so next request gets correct badge
      const jobMatch = pathOnly.match(/^\/vakansia\/(.+)$/);
      if (jobMatch) {
        const jobIdRaw = extractIdFromSlug(jobMatch[1]);
        const jobId = jobIdRaw ? parseInt(jobIdRaw, 10) : null;
        if (jobId && !isNaN(jobId)) {
          try {
            const row = await db("jobs").where({ id: jobId }).select("job_premium_status", "premium_until").first();
            if (row) {
              const isRegular = row.job_premium_status === "regular";
              const zeroDaysLeft =
                row.premium_until != null &&
                ["premium", "premiumPlus"].includes(row.job_premium_status) &&
                String(row.premium_until).slice(0, 10) <= getTodayGeorgiaYYYYMMDD();
              if (isRegular || zeroDaysLeft) {
                pageCache.del(key);
                return next();
              }
            }
          } catch (e) {
            /* continue and serve cached */
          }
          db.raw("UPDATE jobs SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?", [jobId]).catch((e) =>
            console.error("view_count increment error:", e?.message)
          );
          if (req.visitorId) {
            db("jobs").where({ id: jobId }).select("jobSalary", "jobName", "category_id", "job_city", "job_experience", "job_type").first().then(async (job) => {
              if (!job) return;
              const catName = await getCategoryName(job.category_id);
              return db("visitor_job_clicks").insert({
                visitor_id: req.visitorId,
                job_id: jobId,
                job_salary: job.jobSalary || null,
                job_title: job.jobName || null,
                category_id: job.category_id || null,
                job_category_name: catName,
                job_city: job.job_city || null,
                job_experience: job.job_experience || null,
                job_type: job.job_type || null,
                from_recommended: req.query.from === "recommended",
              });
            }).catch((e) => console.error("visitor_job_clicks insert error:", e?.message));
          }
        }
      }
      return res.set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache" }).send(cached);
    }
    const origSend = res.send.bind(res);
    res.send = function (body) {
      if (typeof body === "string" && (body.startsWith("<!") || body.startsWith("<html"))) {
        pageCache.set(key, body);
      }
      return origSend(body);
    };
  }
  next();
});

app.use(
  cors({
    origin: [
      "http://localhost:4000",
      "http://localhost:4001",
      "http://hr.samushao.ge:4000",
      "https://samushao.ge",
      "https://hr.samushao.ge",
      "https://samushao-admin.web.app",
      "http://localhost:3000",
    ],
    credentials: true,
  }),
);

// Fonts never change — cache for 1 year
app.use("/fonts", express.static(path.join(__dirname, "public/fonts"), {
  maxAge: "365d",
  immutable: true,
}));
// Serve static files with long cache
app.use(express.static(path.join(__dirname, "public"), { maxAge: "7d" }));
app.use("/uploads", express.static("uploads", { maxAge: "30d" }));

// Redirect trailing slash to clean URL (prevents duplicate canonicals)
// Only for GET/HEAD – redirecting POST etc. would lose the request body
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    if (req.path.endsWith("/") && req.path.length > 1) {
      return res.redirect(301, req.path.slice(0, -1) + (req.url.slice(req.path.length) || ""));
    }
  }
  next();
});

// Set up view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
if (process.env.NODE_ENV !== "production") {
  app.set("view cache", false);
}

// --- robots.txt (dynamic)
app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.send(
    `User-agent: *
Allow: /

Disallow: /my-applications
Disallow: /my-cv

Sitemap: ${SITE_BASE_URL}/sitemap.xml
`,
  );
});

// --- sitemap.xml (dynamic, no cache so it reflects new jobs)
app.get("/sitemap.xml", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  try {
    const jobs = await db("jobs")
      .select("id", "jobName", "updated_at", "created_at")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .orderBy("id", "asc");

    const toDate = (d) => {
      if (!d) return null;
      const date = new Date(d);
      return date.toISOString().slice(0, 10);
    };

    const urls = [
      {
        loc: SITE_BASE_URL + "/",
        lastmod: toDate(new Date()),
        changefreq: "daily",
        priority: "1.0",
      },
      {
        loc: SITE_BASE_URL + "/pricing",
        lastmod: toDate(new Date()),
        changefreq: "monthly",
        priority: "0.8",
      },
      {
        loc: SITE_BASE_URL + "/privacy-policy",
        lastmod: toDate(new Date()),
        changefreq: "monthly",
        priority: "0.5",
      },
      {
        loc: SITE_BASE_URL + "/kvelaze-magalanazgaurebadi-vakansiebi",
        lastmod: toDate(new Date()),
        changefreq: "daily",
        priority: "0.9",
      },
      {
        loc: SITE_BASE_URL + "/kvelaze-motkhovnadi-vakansiebi",
        lastmod: toDate(new Date()),
        changefreq: "daily",
        priority: "0.9",
      },
      {
        loc: SITE_BASE_URL + "/dgevandeli-vakansiebi",
        lastmod: toDate(new Date()),
        changefreq: "daily",
        priority: "0.9",
      },
      ...jobs.map((job) => ({
        loc: `${SITE_BASE_URL}/vakansia/${slugify(job.jobName)}-${job.id}`,
        lastmod: toDate(job.updated_at || job.created_at),
        changefreq: "weekly",
        priority: "0.7",
      })),
    ];

    const escapeXml = (s) =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls
        .map(
          (u) =>
            `  <url>\n    <loc>${escapeXml(u.loc)}</loc>\n` +
            (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : "") +
            (u.changefreq
              ? `    <changefreq>${u.changefreq}</changefreq>\n`
              : "") +
            (u.priority ? `    <priority>${u.priority}</priority>\n` : "") +
            "  </url>",
        )
        .join("\n") +
      "\n</urlset>";

    res.type("application/xml");
    res.send(xml);
  } catch (err) {
    console.error("sitemap error:", err);
    res.status(500).send("Error generating sitemap");
  }
});

// Home route
app.get("/", async (req, res) => {
  try {
    runPremiumExpiryCleanup().catch(() => {});
    runExpiredJobsPineconeCleanup().catch(() => {});

    const {
      category,
      company,
      job_experience,
      job_type,
      work_mode,
      job_city,
      page = 1,
      limit: limitParam = 5,
      hasSalary,
      job_premium_status,
      min_salary,
      q: searchQuery,
      append,
    } = req.query;

    const limit = Number(limitParam);
    const pageNum = Number(page);
    const isAppendRequest = append === "1";

    if (isAppendRequest) {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      res.set("Pragma", "no-cache");
    }

    const filterParamKeys = [
      "category",
      "company",
      "job_experience",
      "job_type",
      "work_mode",
      "job_city",
      "hasSalary",
      "job_premium_status",
      "min_salary",
      "q",
    ];
    const filtersActive = filterParamKeys.some((key) => {
      const v = req.query[key];
      if (v === undefined || v === "") return false;
      return Array.isArray(v) ? v.length > 0 : true;
    });

    const offset = isAppendRequest
      ? (pageNum - 1) * limit
      : 0;
    const fetchLimit = isAppendRequest
      ? limit
      : pageNum * limit;

    // Recommended jobs at top (personalized by visitor clicks + CV sends) – only when no filters
    // Skip for append requests (load more) – client only needs jobs list
    let recommendedJobs = [];
    let topSalaryJobs = [];
    let topSalaryTotalCount = 0;
    let topPopularJobs = [];
    let topPopularTotalCount = 0;
    let todayJobs = [];
    let todayJobsCount = 0;
    let topCvFitJobs = [];
    let topCvFitTotalCount = 0;
    let formSubmissionJobs = [];
    let formSubmissionTotalCount = 0;

    // Defer below-fold sections (today's jobs, main jobs) on initial load when no filters – load on scroll
    const deferBelowFold = !isAppendRequest && !filtersActive;

    if (!isAppendRequest) {
    if (!filtersActive && (req.visitorId || req.session?.user?.uid)) {
      const rec = await getRecommendedJobs(db, req.visitorId, {
        limit: 20,
        offset: 0,
        userUid: req.session?.user?.uid,
      });
      if (rec.jobs && rec.jobs.length > 0) {
        recommendedJobs = rec.jobs;
      }
    }

    // Top salary jobs slider – skip when any filters are active
    if (!filtersActive) {
      // Top salary: slot 1 = highest paid non-boosted; slots 2-3 = premium first, then prioritized (premium > prioritize)
        const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || j.prioritize === "true" || ["premium", "premiumPlus"].includes(j.job_premium_status);
        let topSalaryRaw = await db("jobs")
          .select(...JOBS_LIST_COLUMNS)
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .whereNotNull("jobSalary_min")
          .orderBy("jobSalary_min", "desc")
          .limit(50);
        const prioritizedWithSalary = await db("jobs")
          .select(...JOBS_LIST_COLUMNS)
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .where((qb) => qb.where("prioritize", true).orWhereIn("job_premium_status", ["premium", "premiumPlus"]))
          .whereNotNull("jobSalary_min")
          .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
          .orderBy("jobSalary_min", "desc")
          .limit(2);
        const topSeen = new Set();
        topSalaryRaw = topSalaryRaw.filter((j) => {
          const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
          if (topSeen.has(key)) return false;
          topSeen.add(key);
          return true;
        });
        const dedupePrioritized = [];
        const seenP = new Set();
        for (const j of prioritizedWithSalary) {
          const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
          if (!seenP.has(key)) {
            seenP.add(key);
            dedupePrioritized.push(j);
          }
        }
        const nonBoosted = topSalaryRaw.filter((j) => !isBoosted(j));
        const slot1 = (nonBoosted[0] || topSalaryRaw[0]);
        const prioritizedFor23 = dedupePrioritized.slice(0, 2);
        const usedIds = new Set([slot1?.id, ...prioritizedFor23.map((j) => j.id)].filter(Boolean));
        const restBySalary = topSalaryRaw.filter((j) => !usedIds.has(j.id));
        const minPremiumSalaryForTopSalary = 2000;
        const includePremiumInTopSalary = (j) => {
          if (!j) return false;
          const isPremium = ["premium", "premiumPlus"].includes(j.job_premium_status);
          if (isPremium) {
            const salary = parseInt(j.jobSalary_min, 10) || 0;
            return salary >= minPremiumSalaryForTopSalary;
          }
          return true;
        };
        topSalaryJobs = [slot1, ...prioritizedFor23, ...restBySalary]
          .filter(Boolean)
          .filter(includePremiumInTopSalary)
          .slice(0, 20);
        topSalaryTotalCount = topSalaryJobs.length;

      // Top popular: slot 1 = most viewed non-boosted; slots 2-3 = premium first, then prioritized
        let topPopularRaw = await db("jobs")
          .select(...JOBS_LIST_COLUMNS)
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .orderByRaw("COALESCE(view_count, 0) DESC")
          .limit(50);
        const prioritizedForPopular = await db("jobs")
          .select(...JOBS_LIST_COLUMNS)
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .where((qb) => qb.where("prioritize", true).orWhereIn("job_premium_status", ["premium", "premiumPlus"]))
          .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
          .orderByRaw("COALESCE(view_count, 0) DESC")
          .limit(2);
        const seenPop = new Set();
        topPopularRaw = topPopularRaw.filter((j) => {
          const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
          if (seenPop.has(key)) return false;
          seenPop.add(key);
          return true;
        });
        const dedupePrioritizedPop = [];
        const seenPPop = new Set();
        for (const j of prioritizedForPopular) {
          const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
          if (!seenPPop.has(key)) {
            seenPPop.add(key);
            dedupePrioritizedPop.push(j);
          }
        }
        const nonBoostedPop = topPopularRaw.filter((j) => !isBoosted(j));
        const slot1Pop = (nonBoostedPop[0] || topPopularRaw[0]);
        const prioritizedFor23Pop = dedupePrioritizedPop.slice(0, 2);
        const usedIdsPop = new Set([slot1Pop?.id, ...prioritizedFor23Pop.map((j) => j.id)].filter(Boolean));
        const restByViews = topPopularRaw.filter((j) => !usedIdsPop.has(j.id));
        topPopularJobs = [slot1Pop, ...prioritizedFor23Pop, ...restByViews].filter(Boolean).slice(0, 20);
        topPopularTotalCount = topPopularJobs.length;

      // Today's jobs (დღევანდელი ვაკანსიები) – skipped when deferBelowFold (loaded on scroll)
      if (!deferBelowFold) {
        todayJobs = await db("jobs")
          .select(...JOBS_LIST_COLUMNS)
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .whereRaw(`${DATE_IN_GEORGIA} = ${TODAY_IN_GEORGIA}`)
          .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc");
        const seenToday = new Set();
        todayJobs = todayJobs.filter((j) => {
          const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
          if (seenToday.has(key)) return false;
          seenToday.add(key);
          return true;
        });
        todayJobsCount = todayJobs.length;
      }

      // Form submission jobs (ვაკანსიები სადაც CV გარეშე მიგიღებენ) – jobs that accept form without CV
      const formSubRaw = await db("jobs")
        .select(...JOBS_LIST_COLUMNS)
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
        .whereRaw("(accept_form_submissions IS TRUE)")
        .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(50);
      const seenFormSub = new Set();
      formSubmissionJobs = formSubRaw.filter((j) => {
        const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
        if (seenFormSub.has(key)) return false;
        seenFormSub.add(key);
        return true;
      }).slice(0, 20);
      const formSubCountRow = await db("jobs")
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
        .whereRaw("(accept_form_submissions IS TRUE)")
        .count("* as total")
        .first();
      formSubmissionTotalCount = parseInt(formSubCountRow?.total || 0, 10);
    }

    // Top CV-fit jobs (ვაკანსიები სადაც შენი CV ზუსტად ერგება) – when user is logged in and has CV embedding
    if (!filtersActive && req.session?.user?.uid) {
      try {
        const userId = req.session.user.uid;
        let matches;
        const cached = cvFitCache.get(userId);
        if (cached && cached.expiresAt > Date.now()) {
          matches = cached.matches;
        } else {
          const { getTopJobsForUser } = require("./services/pineconeJobs");
          matches = await getTopJobsForUser(userId, 50, 0.4);
          cvFitCache.set(userId, { matches });
        }
        const jobIds = matches.map((m) => parseInt(m.id, 10)).filter((id) => !isNaN(id));
        if (jobIds.length > 0) {
          const jobsFromDb = await db("jobs")
            .whereIn("id", jobIds)
            .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
            .select(...JOBS_LIST_COLUMNS);
          const scoreMap = Object.fromEntries(matches.map((m) => [parseInt(m.id, 10), m.score]));
          const withScore = jobIds
            .map((id) => {
              const job = jobsFromDb.find((j) => j.id === id);
              if (!job) return null;
              return { ...job, score: scoreMap[id] ?? 0 };
            })
            .filter(Boolean);
          // Prioritize premium/premiumPlus first, then prioritize, then rest by score
          const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || j.prioritize === "true" || ["premium", "premiumPlus"].includes(j.job_premium_status);
          const sortRank = (j) => {
            if (["premiumPlus", "premium"].includes(j.job_premium_status) && isBoosted(j)) return j.job_premium_status === "premiumPlus" ? 0 : 1;
            if (j.job_premium_status === "premiumPlus") return 2;
            if (j.job_premium_status === "premium") return 3;
            if (j.prioritize) return 4;
            return 5;
          };
          topCvFitJobs = withScore.sort((a, b) => {
            const ra = sortRank(a);
            const rb = sortRank(b);
            if (ra !== rb) return ra - rb;
            return (b.score ?? 0) - (a.score ?? 0);
          });
          topCvFitTotalCount = topCvFitJobs.length;
        }
      } catch (e) {
        console.error("topCvFitJobs fetch error:", e?.message);
      }
    }
    }

    let query = db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
    let countQuery = db("jobs")
      .count("* as total")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
    // Exclude today's jobs from main listing (ყველა ვაკანსია) – unless filters/search active (today section is hidden)
    if (!filtersActive) {
      query.whereRaw(`${DATE_IN_GEORGIA} < ${TODAY_IN_GEORGIA}`);
      countQuery.whereRaw(`${DATE_IN_GEORGIA} < ${TODAY_IN_GEORGIA}`);
    }

    // Apply same filters to both queries
    if (company) {
      query.where("companyName", company);
      countQuery.where("companyName", company);
    }
    if (category) {
      const cats = Array.isArray(category) ? category : [category];
      query.whereIn("category_id", cats);
      countQuery.whereIn("category_id", cats);
    }
    if (job_experience) {
      const exp = Array.isArray(job_experience)
        ? job_experience
        : [job_experience];
      query.whereIn("job_experience", exp);
      countQuery.whereIn("job_experience", exp);
    }
    if (min_salary) {
      const salaries = (Array.isArray(min_salary) ? min_salary : [min_salary]).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
      if (salaries.length > 0) {
        const min = Math.min(...salaries);
        query.where("jobSalary_min", ">=", min);
        countQuery.where("jobSalary_min", ">=", min);
      }
    }
    if (job_type) {
      const types = Array.isArray(job_type) ? job_type : [job_type];
      query.whereIn("job_type", types);
      countQuery.whereIn("job_type", types);
    }
    if (work_mode) {
      const modes = Array.isArray(work_mode) ? work_mode : [work_mode];
      query.whereIn("work_mode", modes);
      countQuery.whereIn("work_mode", modes);
    }
    if (job_city) {
      const cities = Array.isArray(job_city) ? job_city : [job_city];
      query.whereIn("job_city", cities);
      countQuery.whereIn("job_city", cities);
    }
    if (hasSalary === "true") {
      query.whereNotNull("jobSalary");
      countQuery.whereNotNull("jobSalary");
    }
    if (job_premium_status) {
      const premium = Array.isArray(job_premium_status)
        ? job_premium_status
        : [job_premium_status];
      query.whereIn("job_premium_status", premium);
      countQuery.whereIn("job_premium_status", premium);
    }

    // Search: job name, company name, or job description (case-insensitive)
    if (searchQuery && typeof searchQuery === "string" && searchQuery.trim()) {
      const term =
        "%" +
        searchQuery.trim().replace(/%/g, "\\%").replace(/_/g, "\\_") +
        "%";
      query.andWhereRaw(
        '("jobName" ilike ? OR "companyName" ilike ? OR COALESCE("jobDescription", \'\') ilike ?)',
        [term, term, term]
      );
      countQuery.andWhereRaw(
        '("jobName" ilike ? OR "companyName" ilike ? OR COALESCE("jobDescription", \'\') ilike ?)',
        [term, term, term]
      );
    }

    // Get total count
    const [{ total }] = await countQuery;
    const totalPages = Math.ceil(total / Number(limit));

    const PREMIUM_PRIORITIZE_ORDER = `CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`;
    let jobs = await query
      .orderByRaw(PREMIUM_PRIORITIZE_ORDER)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(fetchLimit)
      .offset(offset);

    // Deduplicate: same job name + company = keep first (by our sort order)
    const seenKey = new Set();
    jobs = jobs.filter((j) => {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });

    const baseUrl = "https://samushao.ge";
    const canonical = baseUrl + (pageNum === 1 ? "/" : "/?page=" + pageNum);
    res.render("index", {
      jobs,
      recommendedJobs,
      topSalaryJobs,
      topSalaryTotalCount,
      topPopularJobs,
      topPopularTotalCount,
      topCvFitJobs: topCvFitJobs || [],
      topCvFitTotalCount: topCvFitTotalCount || 0,
      formSubmissionJobs: formSubmissionJobs || [],
      formSubmissionTotalCount: formSubmissionTotalCount || 0,
      todayJobs,
      todayJobsCount,
      currentPage: pageNum,
      totalPages,
      totalJobs: total,
      filters: req.query,
      filtersActive,
      paginationBase: "/",
      deferBelowFold: deferBelowFold || false,
      slugify,
      seo: {
        title: "ვაკანსიები | Samushao.ge",
        description:
          "ვაკანსიები საქართველოში. იპოვე სამუშაო და გაგზავნე CV პირდაპირ კომპანიებში.",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
        canonical,
      },
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Most popular jobs page – 20 most viewed; slots 2-3 = premium first, then prioritized
app.get("/kvelaze-motkhovnadi-vakansiebi", async (req, res) => {
  try {
    const topLimit = 20;
    const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || ["premium", "premiumPlus"].includes(j.job_premium_status);
    let jobsRaw = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .orderByRaw("COALESCE(view_count, 0) DESC")
      .limit(50);
    const prioritizedWithViews = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .where((qb) => qb.where("prioritize", true).orWhereIn("job_premium_status", ["premium", "premiumPlus"]))
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
      .orderByRaw("COALESCE(view_count, 0) DESC")
      .limit(2);
    const seenKey = new Set();
    jobsRaw = jobsRaw.filter((j) => {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });
    const dedupePrioritized = [];
    const seenP = new Set();
    for (const j of prioritizedWithViews) {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (!seenP.has(key)) {
        seenP.add(key);
        dedupePrioritized.push(j);
      }
    }
    const nonBoosted = jobsRaw.filter((j) => !isBoosted(j));
    const slot1 = (nonBoosted[0] || jobsRaw[0]);
    const prioritizedFor23 = dedupePrioritized.slice(0, 2);
    const usedIds = new Set([slot1?.id, ...prioritizedFor23.map((j) => j.id)].filter(Boolean));
    const restByViews = jobsRaw.filter((j) => !usedIds.has(j.id));
    const jobs = [slot1, ...prioritizedFor23, ...restByViews].filter(Boolean).slice(0, topLimit);

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: 0,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: 1,
      totalPages: 1,
      totalJobs: jobs.length,
      filters: {},
      filtersActive: false,
      pageType: "top-views",
      paginationBase: "/kvelaze-motkhovnadi-vakansiebi",
      slugify,
      seo: {
        title: "ყველაზე ნახვადი ვაკანსიები | Samushao.ge",
        description: "ყველაზე ნახვადი ვაკანსიები",
        canonical: "https://samushao.ge/kvelaze-motkhovnadi-vakansiebi",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
      },
    });
  } catch (err) {
    console.error("kvelaze-motkhovnadi-vakansiebi error:", err);
    res.status(500).send(err.message);
  }
});

// Highest paid jobs page – shows only top 20 (same as slider)
app.get("/kvelaze-magalanazgaurebadi-vakansiebi", async (req, res) => {
  try {
    const topLimit = 20;

    // Top salary: slot 1 = highest paid non-boosted; slots 2-3 = premium first, then prioritized
    const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || ["premium", "premiumPlus"].includes(j.job_premium_status);
    let jobsRaw = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .whereNotNull("jobSalary_min")
      .orderBy("jobSalary_min", "desc")
      .limit(50);
    const prioritizedWithSalary = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .where((qb) => qb.where("prioritize", true).orWhereIn("job_premium_status", ["premium", "premiumPlus"]))
      .whereNotNull("jobSalary_min")
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
      .orderBy("jobSalary_min", "desc")
      .limit(2);
    const seenKey = new Set();
    jobsRaw = jobsRaw.filter((j) => {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });
    const dedupePrioritized = [];
    const seenP = new Set();
    for (const j of prioritizedWithSalary) {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (!seenP.has(key)) {
        seenP.add(key);
        dedupePrioritized.push(j);
      }
    }
    const nonBoosted = jobsRaw.filter((j) => !isBoosted(j));
    const slot1 = (nonBoosted[0] || jobsRaw[0]);
    const prioritizedFor23 = dedupePrioritized.slice(0, 2);
    const usedIds = new Set([slot1?.id, ...prioritizedFor23.map((j) => j.id)].filter(Boolean));
    const restBySalary = jobsRaw.filter((j) => !usedIds.has(j.id));
    const jobs = [slot1, ...prioritizedFor23, ...restBySalary].filter(Boolean).slice(0, topLimit);

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: jobs.length,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: 1,
      totalPages: 1,
      totalJobs: jobs.length,
      filters: {},
      filtersActive: false,
      pageType: "top-salary",
      paginationBase: "/kvelaze-magalanazgaurebadi-vakansiebi",
      slugify,
      seo: {
        title: "ყველაზე მაღალანაზღაურებადი ვაკანსიები | Samushao.ge",
        description:
          "ყველაზე მაღალანაზღაურებადი ვაკანსიები",
        canonical: "https://samushao.ge/kvelaze-magalanazgaurebadi-vakansiebi",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
      },
    });
  } catch (err) {
    console.error("kvelaze-magalanazgaurebadi-vakansiebi error:", err);
    res.status(500).send(err.message);
  }
});

// Today's jobs page (დღევანდელი ვაკანსიები)
app.get("/dgevandeli-vakansiebi", async (req, res) => {
  try {
    let jobs = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .whereRaw(`${DATE_IN_GEORGIA} = ${TODAY_IN_GEORGIA}`)
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc");

    const seenKey = new Set();
    jobs = jobs.filter((j) => {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: 0,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: 1,
      totalPages: 1,
      totalJobs: jobs.length,
      filters: {},
      filtersActive: false,
      pageType: "today",
      paginationBase: "/dgevandeli-vakansiebi",
      slugify,
      seo: {
        title: "დღევანდელი ვაკანსიები | Samushao.ge",
        description:
          "დღევანდელი ვაკანსიები. იპოვე სამუშაო და გაგზავნე CV.",
        canonical: "https://samushao.ge/dgevandeli-vakansiebi",
      },
    });
  } catch (err) {
    console.error("dgevandeli-vakansiebi error:", err);
    res.status(500).send(err.message);
  }
});

// Recommended jobs page (შენთვის რეკომენდებული ვაკანსიები)
app.get("/rekomendebuli-vakansiebi", async (req, res) => {
  try {
    const rec = await getRecommendedJobs(db, req.visitorId, {
      limit: 100,
      offset: 0,
      userUid: req.session?.user?.uid,
    });
    const jobs = rec.jobs || [];

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: 0,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: 1,
      totalPages: 1,
      totalJobs: jobs.length,
      filters: {},
      filtersActive: false,
      pageType: "recommended",
      paginationBase: "/rekomendebuli-vakansiebi",
      slugify,
      seo: {
        title: "მსგავს ვაკანსიებს ხშირად სტუმრობ | Samushao.ge",
        description:
          "ვაკანსიები რომლებიც შეესაბამება იმას რაც უკვე დაინტერესებული იყავი.",
        canonical: "https://samushao.ge/rekomendebuli-vakansiebi",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
      },
    });
  } catch (err) {
    console.error("rekomendebuli-vakansiebi error:", err);
    res.status(500).send(err.message);
  }
});

// Jobs that accept form without CV (ვაკანსიები სადაც CV გარეშე მიგიღებენ) – infinite scroll
app.get("/vakansiebi-cv-gareshe", async (req, res) => {
  try {
    const limit = 20;
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const isAppendRequest = req.query.append === "1";
    if (isAppendRequest) {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      res.set("Pragma", "no-cache");
    }

    const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || ["premium", "premiumPlus"].includes(j.job_premium_status);
    let jobsRaw = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .whereRaw("(accept_form_submissions IS TRUE)")
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc");
    const prioritizedFormSub = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .whereRaw("(accept_form_submissions IS TRUE)")
      .where((qb) => qb.where("prioritize", true).orWhereIn("job_premium_status", ["premium", "premiumPlus"]))
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
      .orderBy("created_at", "desc")
      .limit(2);
    const seenKey = new Set();
    jobsRaw = jobsRaw.filter((j) => {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });
    const dedupePrioritized = [];
    const seenP = new Set();
    for (const j of prioritizedFormSub) {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (!seenP.has(key)) {
        seenP.add(key);
        dedupePrioritized.push(j);
      }
    }
    const nonBoosted = jobsRaw.filter((j) => !isBoosted(j));
    const slot1 = (nonBoosted[0] || jobsRaw[0]);
    const prioritizedFor23 = dedupePrioritized.slice(0, 2);
    const usedIds = new Set([slot1?.id, ...prioritizedFor23.map((j) => j.id)].filter(Boolean));
    const rest = jobsRaw.filter((j) => !usedIds.has(j.id));
    const allJobs = [slot1, ...prioritizedFor23, ...rest].filter(Boolean);

    const totalJobs = allJobs.length;
    const totalPages = Math.max(1, Math.ceil(totalJobs / limit));
    const offset = isAppendRequest ? (pageNum - 1) * limit : 0;
    const fetchLimit = isAppendRequest ? limit : pageNum * limit;
    const jobs = allJobs.slice(offset, offset + fetchLimit);

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: 0,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      topCvFitJobs: [],
      topCvFitTotalCount: 0,
      formSubmissionJobs: [],
      formSubmissionTotalCount: totalJobs,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: pageNum,
      totalPages,
      totalJobs,
      filters: {},
      filtersActive: false,
      pageType: "form-submission",
      paginationBase: "/vakansiebi-cv-gareshe",
      slugify,
      seo: {
        title: "ვაკანსიები სადაც CV გარეშე მიგიღებენ | Samushao.ge",
        description: "ვაკანსიები რომლებშიც განაცხადის ფორმის შევსება შეგიძლიათ CV-ის გაგზავნის გარეშე.",
        canonical: "https://samushao.ge/vakansiebi-cv-gareshe",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
      },
    });
  } catch (err) {
    console.error("vakansiebi-cv-gareshe error:", err);
    res.status(500).send(err.message);
  }
});

// Jobs where your CV fits (ვაკანსიები სადაც შენი CV ზუსტად ერგება) – requires login, uses Pinecone CV matching
app.get("/vakansiebi-shentvis", async (req, res) => {
  try {
    let jobs = [];
    const userUid = req.session?.user?.uid;
    if (userUid) {
      try {
        let matches;
        const cached = cvFitCache.get(userUid);
        if (cached && cached.expiresAt > Date.now()) {
          matches = cached.matches;
        } else {
          const { getTopJobsForUser } = require("./services/pineconeJobs");
          matches = await getTopJobsForUser(userUid, 50, 0.4);
          cvFitCache.set(userUid, { matches });
        }
        const jobIds = matches.map((m) => parseInt(m.id, 10)).filter((id) => !isNaN(id));
        if (jobIds.length > 0) {
          const jobsFromDb = await db("jobs")
            .whereIn("id", jobIds)
            .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
            .select(...JOBS_LIST_COLUMNS);
          const scoreMap = Object.fromEntries(matches.map((m) => [parseInt(m.id, 10), m.score]));
          const withScore = jobIds
            .map((id) => {
              const job = jobsFromDb.find((j) => j.id === id);
              if (!job) return null;
              return { ...job, score: scoreMap[id] ?? 0 };
            })
            .filter(Boolean);
          const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || j.prioritize === "true" || ["premium", "premiumPlus"].includes(j.job_premium_status);
          const sortRank = (j) => {
            if (["premiumPlus", "premium"].includes(j.job_premium_status) && isBoosted(j)) return j.job_premium_status === "premiumPlus" ? 0 : 1;
            if (j.job_premium_status === "premiumPlus") return 2;
            if (j.job_premium_status === "premium") return 3;
            if (j.prioritize) return 4;
            return 5;
          };
          jobs = withScore.sort((a, b) => {
            const ra = sortRank(a);
            const rb = sortRank(b);
            if (ra !== rb) return ra - rb;
            return (b.score ?? 0) - (a.score ?? 0);
          });
        }
      } catch (e) {
        console.error("vakansiebi-shentvis fetch error:", e?.message);
      }
    }

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: 0,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      topCvFitJobs: [],
      topCvFitTotalCount: jobs.length,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: 1,
      totalPages: 1,
      totalJobs: jobs.length,
      filters: {},
      filtersActive: false,
      pageType: "top-cv-fit",
      paginationBase: "/vakansiebi-shentvis",
      slugify,
      seo: {
        title: "ვაკანსიები სადაც შენი CV ერგება | Samushao.ge",
        description: "ვაკანსიები რომლებიც ზუსტად შეესაბამება შენი CV-ს.",
        canonical: "https://samushao.ge/vakansiebi-shentvis",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
      },
    });
  } catch (err) {
    console.error("vakansiebi-shentvis error:", err);
    res.status(500).send(err.message);
  }
});

// Privacy policy page
app.get("/privacy-policy", (req, res) => {
  res.render("privacy-policy", {
    seo: {
      title: "მონაცემთა დაცვის პოლიტიკა | Samushao.ge",
      description: "Samushao.ge მონაცემთა დაცვის პოლიტიკა.",
      canonical: "https://samushao.ge/privacy-policy",
    },
  });
});

// Terms of use page
app.get("/terms-of-use", (req, res) => {
  res.render("terms-of-use", {
    seo: {
      title: "გამოყენების პირობები | Samushao.ge",
      description: "Samushao.ge გამოყენების პირობები.",
      canonical: "https://samushao.ge/terms-of-use",
    },
  });
});

// Test route to verify Sentry (remove in production if desired)
app.get("/debug-sentry", function mainHandler(req, res) {
  Sentry.captureException(new Error("My first Sentry error!"));
  throw new Error("My first Sentry error!");
});

// Pricing page
app.get("/pricing", (req, res) => {
  res.render("pricing", {
    seo: {
      title: "ფასები | Samushao.ge",
      description:
        "Samushao.ge ფასები და პაკეტები ვაკანსიების გამოქვეყნებისთვის.",
      canonical: "https://samushao.ge/pricing",
    },
  });
});

// CV creator (sheqmeni-cv) – same look as main index, AI chat to build CV
app.get("/sheqmeni-cv", async (req, res) => {
  try {
    const user = req.session?.user || null;
    let existingCvHtml = null;

    // On page load/refresh always reset in-memory CV creator state
    if (req.session) {
      req.session.cvCreatorHistory = [];
      req.session.cvCreatorCvData = {};
      req.session.cvCreatorHasExisting = false;
    }

    if (user && user.user_type === "user") {
      const resume = await db("resumes")
        .where("user_id", String(user.uid))
        .andWhere("created_cv_on_samushao_ge", true)
        .orderBy("updated_at", "desc")
        .first();
      if (resume && resume.cv_html) {
        existingCvHtml = resume.cv_html;
        if (req.session) req.session.cvCreatorHasExisting = true;
      } else if (req.session) {
        req.session.cvCreatorHasExisting = false;
      }
    } else if (req.session) {
      req.session.cvCreatorHasExisting = false;
    }

    res.render("sheqmeni-cv", {
      seo: {
        title: "შევქმნათ CV | Samushao.ge",
        description: "AI-ს დახმარებით შექმენი შენი CV.",
        canonical: "https://samushao.ge/sheqmeni-cv",
      },
      user,
      existingCvHtml,
    });
  } catch (err) {
    console.error("/sheqmeni-cv error:", err?.message || err);
    res.status(500).send("Error loading CV creator");
  }
});

// API: CV creator chat – backed by Gemini
app.post("/api/sheqmeni-cv/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const isInitial = body.initial === true;
    const rawMessage = (body.message || "").trim();

    if (!req.session) {
      return res.status(500).json({ error: "session unavailable" });
    }
    if (!Array.isArray(req.session.cvCreatorHistory)) {
      req.session.cvCreatorHistory = [];
    }
    const history = req.session.cvCreatorHistory;

    // First message: fixed onboarding question (deterministic)
    const hadExistingCv = !!req.session?.cvCreatorHasExisting;
    const FIRST_QUESTION = hadExistingCv
      ? "რა გინდა რომ შევცვალოთ შენს რეზიუმეში?"
      : "მე რამდენიმე კითხვას დაგისვამ, და შემდეგ გაგიკეთებ რეზიუმეს შენი პასუხების მიხედვით. დავიწყოთ?";
    if (isInitial && history.length === 0) {
      const reply = FIRST_QUESTION;
      history.push({ role: "assistant", content: reply });
      req.session.cvCreatorHistory = history;
      return res.json({ reply });
    }

    if (!rawMessage) {
      return res.status(400).json({ error: "message required" });
    }

    history.push({ role: "user", content: rawMessage });

    let model;
    try {
      model = getCvCreatorModel();
    } catch (e) {
      console.error("[Gemini] CV creator init failed:", e?.message || e);
      const fallback =
        "ამ დროს AI მოდელი დროებით მიუწვდომელია. შეგიძლია მაინც მომწერო შენი განათლება, სამუშაო გამოცდილება და უნარები, და sistemashi shevinaxavt.";
      history.push({ role: "assistant", content: fallback });
      req.session.cvCreatorHistory = history;
      return res.json({ reply: fallback });
    }

    const systemPrompt = `
    You are a CV-building assistant for Samushao.ge.
    
    LANGUAGE RULE:
    - You MUST speak ONLY Georgian (ქართული ენა).
    - Never switch languages.
    
    GOAL:
    You are collecting structured CV data step-by-step.
    You must continue asking questions until ALL required fields are filled.
    
    REQUIRED FIELDS:
    - name
    - surname
    - email
    - phone
    - city (მოწერე შენი ქალაქი/ქვეყანა, напр: თბილისი, საქართველო)
    
    QUESTION FLOW RULES:
    - Ask for name, surname, email, phone and city in ONE message.
    - Ask for work experience (position, company, start_date, end_date) in ONE message. ( if they dont have work experience/education, generate a generally good positive summary about them, like they are motivated etc.)
    - Never ask whether to include skills. Automatically generate skills.
    - Automatically generate and update Professional Summary every time.
    - Never ask user if something should be included.
    - If user requests change, update data and resend full CV state.
    - Never stop asking questions until ALL required data exists.
    - don't loop questions if you dont receive answers, just say "thats your CV then".
    - when all the information is gathered and user is not asking anything, or the questions repeat,  tell them their resume is finished, and would they like it to be saved? tell them you can save it or they can click "save resume" to save it.
    - if they ask where they can see this resume, tell them it's on samushao.ge/my-cv, make this a clickable link so they can click..

    ACTION RULE (CRITICAL):
    - When the user confirms they want to save the CV (e.g. "დიახ", "დიახ შეინახე", "შეგიძლია შეინახო", "yes", "yes save it", "დიახ გინდა"), add "action": "save_cv" at the top level of the JSON (alongside updatedFields).
    - Use "action": "save_cv" ONLY when the user explicitly confirms saving. Never use it when asking, suggesting, or when user says no.
    - If the user does not confirm saving, omit the "action" field or use "action": null.

    RESPONSE RULE AND RESPONSE LENGTH RULE:
    - Natural-language response must never exceed 15 words.
    - This rule does NOT apply to JSON.
    - Always end natural-language response with a clear question
      asking for the next missing required field.
    - when you see user provided most of the information, or even when not,  but  you have already asked for it once, offer them to save a CV.
    
    THINGS YOU SHOULD GENERATE WITHOUT BEING ASKED:
    - After you have job experience info:
      - Professional Summary
      - Skills
      - Job duties description for each job experience.
    - LANGUAGES:
      - If the user mentions any languages they know, ALWAYS ask their proficiency level for each language
        (for example: A1–C2, beginner / intermediate / advanced, native, fluent).
      - Store this in the \`languages\` array as objects: { "name": "<language>", "level": "<proficiency>" }.
    - CERTIFICATES:
      - If the user mentions any certificates, courses or trainings, ask:
        name of certificate, issuing organization and year (if they remember).
      - Store this in the \`certificates\` array as objects:
        { "name": "<certificate name>", "issuer": "<organization>", "year": "<year or empty string>" }.
    - OTHER GENERAL INFO:
      - If the user mentions other general info such as driver's license, military service, hobbies or similar,
        store this text in the \`otherInfo\` field (single string, you can concatenate multiple facts there).
    
    STATE & JSON RULE (CRITICAL):
    - The backend always sends you the FULL current CV JSON.
    - You MUST NOT rewrite or regenerate the entire CV object.
    - You MUST ONLY return the specific fields that need to change.
    - Do NOT include untouched fields in JSON.
    - "experience" must be an array if you change it.
    - "jobs" must always be an array of objects if you change it.
    - Never output [object Object].
    - Never output JSON in the converastion with user, like "json": {...}
    
    JSON FORMAT (STRICT):
    - At the end of every reply, output ONLY this JSON shape ( never show this to users ):
    
    \`\`\`json
    {
      "updatedFields": {
        "name": "",
        "surname": "",
        "email": "",
        "phone": "",
        "city": "",
        "education": "",
        "experience": [],
        "skills": "",
        "summary": "",
        "profession": "",
        "jobs": [
          {
            "company": "",
            "position": "",
            "start_date": "",
            "end_date": "",
            "summary": "",
            "duties": ""
          }
        ],
        "languages": [
          {
            "name": "",
            "level": ""
          }
        ],
        "certificates": [
          {
            "name": "",
            "issuer": "",
            "year": ""
          }
        ],
        "otherInfo": ""
      },
      "action": "save_cv"
    }
    \`\`\`
    - Include "action": "save_cv" only when user confirms saving; otherwise omit "action" or use null.
    `;


    const transcript = history
      .map((m) =>
        m.role === "user"
          ? `მომხმარებელი: ${m.content}`
          : `ასისტენტი: ${m.content}`
      )
      .join("\n");

    const currentCvJson = JSON.stringify(req.session.cvCreatorCvData || {}, null, 2);

    const prompt = `${systemPrompt}

ამჟამინდელი CV JSON (მხოლოდ შენთვის, არ აჩვენო მომხმარებელს როგორც ტექსტი):
\`\`\`json
${currentCvJson}
\`\`\`

დიალოგი აქამდე:
${transcript}

---

ახლა გააგრძელე როგორც ასისტენტი. დაწერე მოკლე პასუხი ქართულად და ბოლოში სავალდებულოდ დაამატე JSON ბლოკი \"updatedFields\" ობიექტით.`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0 },
    });
    const response = result?.response;
    const text = (response && response.text && response.text()) || "";
    let reply = text.trim().slice(0, 4000) || "ამ დროს პასუხის გენერაცია ვერ მოხერხდა. სცადე თავიდან ცოტა ხანში.";

    // Extract CV JSON block from end of reply (format: ```json\n{...}\n```)
    let cvData = req.session.cvCreatorCvData || {};
    let shouldSaveCv = false;
    const jsonMatch = reply.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed && typeof parsed.updatedFields === "object") {
          const u = parsed.updatedFields;
          const allowedKeys = new Set([
            "name",
            "surname",
            "email",
            "phone",
            "city",
            "education",
            "experience",
            "skills",
            "summary",
            "profession",
            "jobs",
            "languages",
            "certificates",
            "otherInfo",
          ]);
          const set = (k, v) => {
            if (!allowedKeys.has(k) || v == null) return;
            if (k === "jobs" || k === "experience" || k === "languages" || k === "certificates") {
              if (Array.isArray(v) && v.length === 0) return;
              cvData[k] = v;
            } else {
              const s = String(v).trim();
              if (s) cvData[k] = s;
            }
          };
          Object.keys(u).forEach((key) => set(key, u[key]));
          req.session.cvCreatorCvData = cvData;
        }
        if (parsed?.action === "save_cv") {
          shouldSaveCv = true;
        }
      } catch (e) {
        console.warn("[Gemini] CV JSON parse failed:", e?.message);
      }
      reply = reply.replace(/```json\s*[\s\S]*?\s*```/g, "").trim();
    }

    // Execute save when Gemini returned action: "save_cv" (user confirmed)
    if (shouldSaveCv && req.session?.user?.user_type === "user") {
      const userUid = req.session.user.uid;
      const hasAnyData = Object.values(cvData || {}).some((v) =>
        v && (Array.isArray(v) ? v.length : String(v).trim && String(v).trim())
      );
      if (hasAnyData) {
        try {
          await saveCvForUser(userUid, cvData);
          reply = (reply || "").trim() || "შენახულია.";
        } catch (saveErr) {
          console.error("[CV creator] auto-save failed:", saveErr?.message || saveErr);
          reply = (reply || "").trim() + " (შენახვა ვერ მოხერხდა — სცადე ღილაკით.)";
        }
      }
    }

    history.push({ role: "assistant", content: reply });
    req.session.cvCreatorHistory = history;

    // Accumulate chat turns in session; persist to cv_creator_chat_logs every 15 seconds (on next request after 15s)
    const FLUSH_INTERVAL_MS = 15 * 1000;
    try {
      if (!Array.isArray(req.session.cvCreatorLogTurns)) {
        req.session.cvCreatorLogTurns = [];
        req.session.cvCreatorLogLastFlushAt = null;
      }
      const turnIndex = history.filter((m) => m.role === "assistant").length - 1;
      req.session.cvCreatorLogTurns.push({
        turn_index: isNaN(turnIndex) || turnIndex < 0 ? 0 : turnIndex,
        had_existing_cv: hadExistingCv,
        user_message: rawMessage,
        assistant_reply: reply,
        cv_data: cvData ? { ...cvData } : null,
      });
      const now = Date.now();
      const lastFlush = req.session.cvCreatorLogLastFlushAt;
      if (lastFlush == null || now - lastFlush >= FLUSH_INTERVAL_MS) {
        const turns = req.session.cvCreatorLogTurns;
        if (turns.length > 0) {
          const sessionId = req.session.id || req.sessionID || null;
          const userId =
            req.session.user && req.session.user.uid
              ? String(req.session.user.uid)
              : null;
          const rows = turns.map((t) => ({
            session_id: sessionId,
            user_id: userId,
            turn_index: t.turn_index,
            had_existing_cv: t.had_existing_cv,
            user_message: t.user_message,
            assistant_reply: t.assistant_reply,
            cv_data: t.cv_data,
          }));
          await db("cv_creator_chat_logs").insert(rows);
          req.session.cvCreatorLogTurns = [];
        }
        req.session.cvCreatorLogLastFlushAt = now;
      }
    } catch (e) {
      console.warn(
        "[CV creator log] failed to persist chat log:",
        e?.message || e
      );
    }

    res.json({ reply, cvData });
  } catch (err) {
    console.error("[Gemini] CV creator chat error:", err?.message || err);
    const detail = err?.message || String(err);
    res.status(500).json({
      error: "cv_creator_gemini_failed",
      message:
        "დაფიქსირდა შეცდომა AI სერვისიდან. ეს არ არის samushao.ge-ის პრობლემა — გთხოვთ სცადოთ თავიდან.",
      detail: detail,
    });
  }
});

/** Save AI-generated CV to resumes table (PDF via Puppeteer + Cloudinary). Reusable for chat auto-save. */
async function saveCvForUser(userUid, cv) {
  const hasAnyData = Object.values(cv || {}).some((v) =>
    v && (Array.isArray(v) ? v.length : String(v).trim && String(v).trim())
  );
  if (!hasAnyData) throw new Error("no cv data");

  const html = buildCvHtmlFromData(cv);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "0mm", bottom: "0mm", left: "0mm", right: "0mm" },
  });
  await browser.close();

  const rawName =
    cv.name || cv.surname
      ? `${cv.name || ""} ${cv.surname || ""}`.trim()
      : `CV-${userUid}`;
  const fileName = `${rawName} CV.pdf`.slice(0, 190);

  const result = await new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: "raw",
        folder: "resumes",
        use_filename: true,
        unique_filename: true,
        access_mode: "public",
        filename_override: fileName,
      },
      (error, res) => (error ? reject(error) : resolve(res))
    );
    uploadStream.end(pdfBuffer);
  });

  const downloadUrl = cloudinary.url(result.public_id, {
    resource_type: "raw",
    type: "upload",
    flags: "attachment",
  });

  const basePayload = {
    file_url: downloadUrl,
    user_id: String(userUid),
    file_name: fileName,
    created_cv_on_samushao_ge: true,
    cv_html: html,
  };

  const existing = await db("resumes")
    .where("user_id", String(userUid))
    .andWhere("created_cv_on_samushao_ge", true)
    .orderBy("updated_at", "desc")
    .first();

  if (existing) {
    await db("resumes")
      .where("id", existing.id)
      .update({ ...basePayload, updated_at: db.fn.now() });
  } else {
    await db("resumes").insert(basePayload);
  }

  const { indexCandidateFromCvUrl } = require("./services/pineconeCandidates");
  const { invalidate } = require("./services/cvFitCache");
  indexCandidateFromCvUrl(String(userUid), downloadUrl, fileName)
    .then(() => invalidate(String(userUid)))
    .catch((err) => console.warn("[Pinecone] Failed to index CV for user", userUid, err.message));
}

// Save AI-generated CV as PDF in resumes table (server-side PDF via Puppeteer)
app.post("/api/sheqmeni-cv/save", async (req, res) => {
  try {
    if (!req.session?.user || req.session.user.user_type !== "user") {
      return res.status(403).json({ error: "unauthorized" });
    }
    const userUid = req.session.user.uid;
    const cv = req.body?.cv || {};

    const hasAnyData = Object.values(cv || {}).some((v) =>
      v && String(v).trim && String(v).trim()
    );
    if (!hasAnyData) {
      return res.status(400).json({ error: "no cv data" });
    }

    await saveCvForUser(userUid, cv);
    res.json({ ok: 1 });
  } catch (err) {
    console.error("/api/sheqmeni-cv/save error:", err?.message || err);
    res.status(500).json({
      error: "cv_save_failed",
      message: err?.message || String(err),
    });
  }
});

// My applications (sent CVs) - user type only
app.get("/my-applications", async (req, res) => {
  if (!req.session?.user) {
    return res.redirect("/");
  }
  if (req.session.user.user_type !== "user") {
    return res.redirect("/");
  }
  try {
    const applications = await db("job_applications")
      .where("user_id", req.session.user.uid)
      .orderBy("created_at", "desc");
    const jobIds = applications.map((a) => a.job_id);
    const jobs =
      jobIds.length === 0
        ? []
        : await db("jobs")
            .whereIn("id", jobIds)
            .where("job_status", "approved");
    // Preserve order by application date (newest first)
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const orderedJobs = jobIds.map((id) => jobById.get(id)).filter(Boolean);

    // Load user's automatic CV sending preference (default: true)
    let wantsCvAuto = true;
    try {
      const userRow = await db("users")
        .where("user_uid", req.session.user.uid)
        .first();
      if (userRow && (userRow.wants_cv_to_be_sent === false || userRow.wants_cv_to_be_sent === 0)) {
        wantsCvAuto = false;
      } else {
        wantsCvAuto = true;
      }
    } catch (prefErr) {
      console.error("Failed to load user CV auto-send preference:", prefErr);
    }

    res.render("sent-cvs", {
      jobs: orderedJobs,
      wantsCvAuto,
      slugify,
      seo: {
        title: "გაგზავნილი CV-ები | Samushao.ge",
        description: "ჩემი გაგზავნილი CV-ები.",
        canonical: "https://samushao.ge/my-applications",
      },
    });
  } catch (err) {
    console.error("my-applications error:", err);
    res.status(500).send(err.message);
  }
});

// My CV page – view, delete, upload
app.get("/my-cv", async (req, res) => {
  if (!req.session?.user) {
    return res.redirect("/");
  }
  if (req.session.user.user_type !== "user") {
    return res.redirect("/");
  }
  try {
    const [resume, aiResume] = await Promise.all([
      db("resumes")
        .where("user_id", req.session.user.uid)
        .orderBy("updated_at", "desc")
        .first(),
      db("resumes")
        .where("user_id", req.session.user.uid)
        .whereNotNull("cv_html")
        .orderBy("updated_at", "desc")
        .first(),
    ]);
    res.render("my-cv", {
      resume: resume || null,
      hasSamushaoCv: !!aiResume,
      slugify,
      seo: {
        title: "ჩემი CV | Samushao.ge",
        description: "ნახეთ, განაახლეთ ან წაშალეთ თქვენი CV.",
        canonical: "https://samushao.ge/my-cv",
      },
    });
  } catch (err) {
    console.error("my-cv error:", err);
    res.status(500).send(err.message);
  }
});

// Proxy CV file for inline display (iframe/embed fail with Cloudinary attachment URLs)
app.get("/my-cv/preview", async (req, res) => {
  if (!req.session?.user || req.session.user.user_type !== "user") {
    return res.status(403).send("Forbidden");
  }
  try {
    const resume = await db("resumes")
      .where("user_id", req.session.user.uid)
      .orderBy("updated_at", "desc")
      .first();
    if (!resume?.file_url) {
      return res.status(404).send("CV not found");
    }
    const url = resume.file_url;
    const ext = (resume.file_name || "").toLowerCase().match(/\.(pdf|doc|docx|jpg|jpeg|png|gif|webp)(\?|$)/)?.[1] || "pdf";
    const mime = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }[ext] || "application/octet-stream";
    const fetchRes = await fetch(url);
    if (!fetchRes.ok) {
      return res.status(502).send("Failed to fetch CV");
    }
    const buf = Buffer.from(await fetchRes.arrayBuffer());
    if (ext === "pdf" && buf.length >= 5 && buf.subarray(0, 5).toString() !== "%PDF-") {
      console.warn("[my-cv/preview] Cloudinary returned non-PDF for PDF file, first bytes:", buf.subarray(0, 50).toString("utf8"));
      return res.status(502).send("Invalid CV file");
    }
    res.set("Content-Type", mime);
    res.set("Content-Disposition", "inline");
    res.send(buf);
  } catch (err) {
    console.error("my-cv preview error:", err);
    res.status(500).send("Error loading CV");
  }
});

app.post("/my-cv/delete", async (req, res) => {
  if (!req.session?.user || req.session.user.user_type !== "user") {
    return res.redirect("/");
  }
  const userId = req.session.user.uid;
  try {
    await db("resumes").where("user_id", userId).del();
    const { deleteCandidate } = require("./services/pineconeCandidates");
    await deleteCandidate(userId).catch((err) => console.warn("[Pinecone] Failed to delete candidate", userId, err.message));
    cvFitCache.invalidate(userId);
  } catch (err) {
    console.error("my-cv delete error:", err);
  }
  return res.redirect("/my-cv");
});

// Toggle automatic CV sending preference for current user
app.post("/my-applications/auto-send-toggle", async (req, res) => {
  if (!req.session?.user || req.session.user.user_type !== "user") {
    return res.redirect("/");
  }
  try {
    const current = await db("users")
      .where("user_uid", req.session.user.uid)
      .first();
    const currentValue =
      current && (current.wants_cv_to_be_sent === true || current.wants_cv_to_be_sent === 1);
    const nextValue = !currentValue;
    await db("users")
      .where("user_uid", req.session.user.uid)
      .update({
        wants_cv_to_be_sent: nextValue,
        consent_updated_at: db.fn.now(),
      });
    return res.redirect("/my-applications");
  } catch (err) {
    console.error("auto-send-toggle error:", err);
    return res.redirect("/my-applications");
  }
});

// Related jobs cache (keyed by category_id, 5-minute TTL)
const relatedJobsCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
app.locals.relatedJobsCache = relatedJobsCache;

async function getRelatedJobsCached(categoryId, excludeJobId) {
  const cacheKey = `related_${categoryId}`;
  const cached = relatedJobsCache.get(cacheKey);
  if (cached) {
    return cached.filter((j) => j.id !== excludeJobId).slice(0, 5);
  }
  const relatedJobsRaw = await db("jobs")
    .select(...JOBS_LIST_COLUMNS)
    .where("job_status", "approved")
    .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
    .where((qb) => {
      qb.where("category_id", categoryId)
        .orWhere("prioritize", true)
        .orWhereIn("job_premium_status", ["premium", "premiumPlus"]);
    })
    .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
    .orderByRaw("(CASE WHEN category_id = ? THEN 1 ELSE 0 END) DESC", [categoryId])
    .orderBy("created_at", "desc")
    .limit(12);
  const isPremium = (j) => ["premium", "premiumPlus"].includes(j.job_premium_status);
  const premiumIdx = relatedJobsRaw.findIndex((j) => isPremium(j));
  let sorted;
  if (relatedJobsRaw.length >= 2 && premiumIdx > 1) {
    const [first, , ...rest] = relatedJobsRaw;
    const premium = relatedJobsRaw[premiumIdx];
    const restWithoutPremium = relatedJobsRaw.filter((_, i) => i !== 0 && i !== premiumIdx);
    sorted = [first, premium, ...restWithoutPremium];
  } else {
    sorted = relatedJobsRaw;
  }
  relatedJobsCache.set(cacheKey, sorted);
  return sorted.filter((j) => j.id !== excludeJobId).slice(0, 5);
}

// Category name cache (rarely changes)
const categoryNameCache = new NodeCache({ stdTTL: 3600 });
async function getCategoryName(categoryId) {
  if (!categoryId) return null;
  const cached = categoryNameCache.get(categoryId);
  if (cached !== undefined) return cached;
  const cat = await db("categories").where("id", categoryId).select("name").first();
  const name = (cat && cat.name) || null;
  categoryNameCache.set(categoryId, name);
  return name;
}

// get vacancy inner page
app.get("/vakansia/:slug", async (req, res) => {
  try {
    await runPremiumExpiryCleanup();
    runExpiredJobsPineconeCleanup().catch(() => {});

    const slug = req.params.slug;
    const jobIdRaw = extractIdFromSlug(slug);
    const jobId = jobIdRaw ? parseInt(jobIdRaw, 10) : null;

    if (!jobId || isNaN(jobId)) {
      return res.status(404).render("404", { message: "Job not found" });
    }

    let job;
    let shellMode = false;
    const cachedJobB64 = req.get("X-Cached-Job");
    const isBot = /bot|crawl|spider|slurp|baidu|yandex|google|bing|facebook|twitter|linkedin/i.test(req.get("user-agent") || "");

    if (cachedJobB64) {
      let cached;
      try {
        cached = JSON.parse(Buffer.from(cachedJobB64, "base64").toString("utf8"));
      } catch (e) {
        cached = null;
      }
      if (cached && cached.id === jobId && cached.jobName && cached.companyName) {
        const exists = await db("jobs").where({ id: jobId, job_status: "approved" }).select("id").first();
        if (exists) {
          job = { ...cached, jobDescription: "", job_description: "" };
          shellMode = true;
        }
      }
    }
    if (!job) {
      if (isBot) {
        job = await db("jobs").where({ id: jobId, job_status: "approved" }).first();
      } else {
        job = await db("jobs").where({ id: jobId, job_status: "approved" }).select(...JOBS_LIST_COLUMNS).first();
        if (job) shellMode = true;
      }
    }

    if (!job) {
      return res.status(404).render("404", { message: "Job not found" });
    }

    // Always use current premium status from DB (expiry may have run on another instance or request)
    const freshStatus = await db("jobs").where({ id: jobId }).select("job_premium_status", "premium_until").first();
    if (freshStatus) {
      job.job_premium_status = freshStatus.job_premium_status;
      job.premium_until = freshStatus.premium_until;
    }
    // If 0 days left for premium (premium_until <= today Georgia), show as regular and persist
    normalizeJobPremiumByDaysLeft(job);
    if (job.job_premium_status === "regular" && freshStatus && ["premium", "premiumPlus"].includes(freshStatus.job_premium_status)) {
      await db("jobs").where({ id: jobId }).update({ job_premium_status: "regular" });
      const cacheKey = req.originalUrl || req.url;
      if (app.locals.pageCache && cacheKey) app.locals.pageCache.del(cacheKey);
    }

    res.set("Cache-Control", "private, no-cache");

    const correctSlug = slugify(job.jobName) + "-" + job.id;
    if (!cachedJobB64) {
      if (slug !== correctSlug) return res.redirect(301, `/vakansia/${correctSlug}`);
      if (Object.keys(req.query).length > 0) return res.redirect(301, `/vakansia/${correctSlug}`);
    }

    // Fire-and-forget: view_count and visitor tracking
    db.raw("UPDATE jobs SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?", [jobId]).catch((e) =>
      console.error("view_count increment error:", e?.message)
    );
    if (req.visitorId) {
      getCategoryName(job.category_id).then((catName) =>
        db("visitor_job_clicks").insert({
          visitor_id: req.visitorId,
          job_id: jobId,
          job_salary: job.jobSalary || null,
          job_title: job.jobName || null,
          category_id: job.category_id || null,
          job_category_name: catName,
          job_city: job.job_city || null,
          job_experience: job.job_experience || null,
          job_type: job.job_type || null,
          from_recommended: req.query.from === "recommended",
        })
      ).catch((e) => console.error("visitor_job_clicks insert error:", e?.message));
    }

    // Always fetch related jobs so "Similar jobs" section is visible on job detail page
    const [application, formSubmission, relatedJobs] = await Promise.all([
      req.session?.user?.uid
        ? db("job_applications")
            .where({ user_id: req.session.user.uid, job_id: jobId })
            .first()
        : null,
      parseJobIdsFromCookie(req).has(jobId)
        ? null
        : req.session?.user?.uid
          ? db("job_form_submissions").where("job_id", jobId).where("user_id", req.session.user.uid).first()
          : req.visitorId
            ? db("job_form_submissions").where("job_id", jobId).where("visitor_id", req.visitorId).first()
            : null,
      getRelatedJobsCached(job.category_id, jobId),
    ]);

    const isExpired = job.expires_at && new Date(job.expires_at) <= new Date();
    const userAlreadyApplied = !!application;
    const userAlreadySubmittedForm = !!formSubmission;

    const jobDescription =
      job.job_description && job.job_description.length > 0
        ? job.job_description.substring(0, 155)
        : job.jobName + " at " + job.companyName;
    const jobCanonical =
      "https://samushao.ge/vakansia/" + slugify(job.jobName) + "-" + job.id;
    const acceptFormSubmissions = job.accept_form_submissions === true || job.accept_form_submissions === 1;
    const userAlreadyAppliedOrSubmitted = userAlreadyApplied || userAlreadySubmittedForm;
    const isHelio = job.isHelio === true || job.isHelio === 1 || job.is_helio === true || job.is_helio === 1;
    const helioUrl = (job.helio_url || job.helioUrl || "").toString().trim() || null;
    res.render("job-detail", {
      job: { ...job, accept_form_submissions: acceptFormSubmissions, isHelio: !!isHelio, helio_url: helioUrl },
      acceptFormSubmissions,
      relatedJobs,
      slugify,
      userAlreadyApplied,
      userAlreadySubmittedForm,
      userAlreadyAppliedOrSubmitted,
      isExpired,
      shellMode,
      seo: {
        title: job.jobName + " | Samushao.ge",
        description: "vakansia - " + jobDescription,
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
        canonical: jobCanonical,
      },
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Lightweight description-only endpoint for shell-mode async loading
const jobDescCache = new NodeCache({ stdTTL: 1800, checkperiod: 120 });
app.locals.jobDescCache = jobDescCache;
app.get("/api/jobs/:id/description", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.set("Pragma", "no-cache");
    const jobId = parseInt(req.params.id, 10);
    if (!jobId || isNaN(jobId)) return res.status(400).json({ error: "Invalid job ID" });

    const cacheKey = `desc_${jobId}`;
    const cached = jobDescCache.get(cacheKey);
    if (cached !== undefined) return res.json({ description: cached });

    const row = await db("jobs")
      .where({ id: jobId, job_status: "approved" })
      .select("jobDescription")
      .first();
    if (!row) return res.status(404).json({ error: "Job not found" });

    const desc = row.jobDescription || "";
    jobDescCache.set(cacheKey, desc);
    res.json({ description: desc });
  } catch (err) {
    console.error("description API error:", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

app.get("/api/ping", (req, res) => res.json({ ok: 1 }));

// Valid pill codes for job feedback
const JOB_FEEDBACK_PILLS = new Set([
  "competitive_salary", "interesting_benefits", "flexible_schedule", "clear_requirements", "good_reputation",
  "vague_description", "unrealistic_requirements", "salary_not_visible", "too_many_responsibilities", "unattractive_benefits"
]);

const { getJobFeedback } = require("./services/getJobFeedback");

// Admin: get aggregated feedback for a job (what people voted for)
app.get("/api/admin/jobs/:id/feedback", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (!jobId || isNaN(jobId)) return res.status(400).json({ error: "Invalid job ID" });
    const feedback = await getJobFeedback(db, jobId);
    if (!feedback) return res.status(404).json({ error: "Job not found" });
    return res.json(feedback);
  } catch (err) {
    console.error("get job feedback error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

app.post("/api/jobs/:id/feedback", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (!jobId || isNaN(jobId)) return res.status(400).json({ error: "Invalid job ID" });
    const job = await db("jobs").where({ id: jobId, job_status: "approved" }).first();
    if (!job) return res.status(404).json({ error: "Job not found" });

    // Cookie: fast first-line check (same browser)
    const ids = parseJobFeedbackIdsFromCookie(req);
    if (ids.has(jobId)) {
      return res.status(400).json({ error: "თქვენ უკვე გაგზავნეთ უკუკავშირი ამ ვაკანსიაზე" });
    }

    // DB: same person (user or visitor) cannot vote twice
    const userId = req.session?.user?.uid || null;
    const visitorId = req.visitorId || null;
    const existingQb = db("job_feedback").where("job_id", jobId);
    if (userId) {
      const existing = await existingQb.clone().where("user_id", userId).first();
      if (existing) return res.status(400).json({ error: "თქვენ უკვე გაგზავნეთ უკუკავშირი ამ ვაკანსიაზე" });
    } else if (visitorId) {
      const existing = await existingQb.clone().where("visitor_id", visitorId).first();
      if (existing) return res.status(400).json({ error: "თქვენ უკვე გაგზავნეთ უკუკავშირი ამ ვაკანსიაზე" });
    }

    const pills = Array.isArray(req.body?.pills) ? req.body.pills : [];
    if (pills.length === 0 || pills.length > 3) {
      return res.status(400).json({ error: "აირჩიეთ 1–3 პუნქტი" });
    }
    const validPills = pills.filter((p) => JOB_FEEDBACK_PILLS.has(String(p)));
    if (validPills.length === 0) {
      return res.status(400).json({ error: "Invalid feedback pills" });
    }

    const insertPayload = { job_id: jobId, pills: JSON.stringify(validPills) };
    if (userId) insertPayload.user_id = userId;
    if (visitorId) insertPayload.visitor_id = visitorId;

    await db("job_feedback").insert(insertPayload);
    setJobFeedbackCookie(res, ids, jobId);

    return res.json({ ok: true, message: "მადლობა, თქვენი აზრი მნიშვნელოვანია!" });
  } catch (err) {
    console.error("job feedback error:", err);
    res.status(500).json({ error: err.message || "An error occurred" });
  }
});

// Cron: send feedback emails to HRs every 2 days (called by external cron-job.org)
// POST /api/cron/send-feedback-emails with header: Authorization: Bearer <CRON_SECRET>
const { sendFeedbackEmails } = require("./services/sendFeedbackEmails");
app.post("/api/cron/send-feedback-emails", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!secret || token !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const testEmail = (req.query.test_email || "").trim();
    const result = await sendFeedbackEmails(db, testEmail ? { testEmail } : {});
    if (!result.ok) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error("send-feedback-emails cron error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/jobs/:id/related", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (!jobId || isNaN(jobId)) return res.status(400).json({ error: "Invalid job ID" });
    const job = await db("jobs").where({ id: jobId, job_status: "approved" }).first();
    if (!job) return res.status(404).json({ error: "Job not found" });

    const relatedJobs = await getRelatedJobsCached(job.category_id, jobId);

    const cards = [];
    for (const j of relatedJobs) {
      const html = await new Promise((resolve, reject) => {
        res.app.render("partials/jobItemCompact", { job: j, slugify, inSlider: true }, (err, str) => {
          if (err) reject(err);
          else resolve(str);
        });
      });
      const isPrem = j.job_premium_status === "premium" || j.job_premium_status === "premiumPlus";
      cards.push({
        html,
        premium: isPrem,
      });
    }
    res.json({ cards });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

cloudinary.config({
  cloud_name: "dd7gz0aqv",
  api_key: "345132216437496",
  api_secret: "gRBZZuGtsxALJlZ7sxh8SCwgTVw",
});

// FB promo enlist: record click, set cookie, redirect to Facebook
const FB_GROUP_URL = "https://www.facebook.com/groups/964592739202329";
app.get("/api/enlist-fb", async (req, res) => {
  try {
    if (!hasEnlistedFbCookie(req)) {
      await db("enlisted_in_fb").insert({
        visitor_id: req.visitorId || null,
        user_id: req.session?.user?.uid || null,
        action: "enlist",
      });
      res.cookie(ENLISTED_FB_COOKIE, "1", {
        maxAge: 10 * 365 * 24 * 60 * 60,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      });
    }
  } catch (err) {
    console.error("enlist-fb error:", err);
  }
  res.redirect(302, FB_GROUP_URL);
});
app.get("/api/dismiss-fb-promo", async (req, res) => {
  try {
    if (!hasEnlistedFbCookie(req)) {
      await db("enlisted_in_fb").insert({
        visitor_id: req.visitorId || null,
        user_id: req.session?.user?.uid || null,
        action: "dismiss",
      });
      res.cookie(ENLISTED_FB_COOKIE, "1", {
        maxAge: 10 * 365 * 24 * 60 * 60,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      });
    }
  } catch (err) {
    console.error("dismiss-fb-promo error:", err);
  }
  res.status(204).end();
});
app.get("/api/enlist-fb/count", async (req, res) => {
  try {
    const [{ count }] = await db("enlisted_in_fb")
      .whereRaw("(action IS NULL OR action = ?)", ["enlist"])
      .count("id as count");
    res.json({ count: parseInt(count, 10) || 0 });
  } catch (err) {
    console.error("enlist-fb count error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Filter counts (contextual: when category=2 active, other counts reflect jobs in that category)
// Cached server-side; invalidated only when new jobs are inserted.
const { getFilterCountsKey, get: getFilterCounts, set: setFilterCounts } = require("./services/filterCountsCache");

app.get("/api/filter-counts", async (req, res) => {
  try {
    const { category, min_salary, job_experience, job_type, work_mode, job_city, q } = req.query;
    const cacheKey = getFilterCountsKey({ category, min_salary, job_experience, job_type, work_mode, job_city, q });
    const cached = getFilterCounts(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    const hasAnyFilter =
      (category && category.length > 0) ||
      (min_salary && min_salary.length > 0) ||
      (job_experience && job_experience.length > 0) ||
      (job_type && job_type.length > 0) ||
      (work_mode && work_mode.length > 0) ||
      (job_city && job_city.length > 0) ||
      (q && typeof q === "string" && q.trim() !== "");

    const filterSearchTerm = (q && typeof q === "string" ? q.trim() : "") || "";
    const baseQuery = () => {
      let query = db("jobs")
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
      if (!hasAnyFilter) {
        query = query.whereRaw("(created_at AT TIME ZONE ?)::date < (NOW() AT TIME ZONE ?)::date", [TZ_GEORGIA, TZ_GEORGIA]);
      }
      return query;
    };

    const applyOtherFilters = (query, exclude) => {
      if (exclude !== "category" && category) {
        const raw = (Array.isArray(category) ? category : [category]).filter((c) => c != null && c !== "");
        const cats = raw.flatMap((c) => String(c).split(",").map((s) => s.trim())).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
        if (cats.length === 1) {
          query.where("category_id", cats[0]);
        } else if (cats.length > 1) {
          query.whereIn("category_id", cats);
        }
      }
      if (exclude !== "min_salary" && min_salary) {
        const salaries = (Array.isArray(min_salary) ? min_salary : [min_salary]).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
        if (salaries.length > 0) query.where("jobSalary_min", ">=", Math.min(...salaries));
      }
      if (exclude !== "job_experience" && job_experience) {
        const exp = (Array.isArray(job_experience) ? job_experience : [job_experience]).filter((e) => e != null && e !== "");
        if (exp.length > 0) query.whereIn("job_experience", exp);
      }
      if (exclude !== "job_type" && job_type) {
        const types = (Array.isArray(job_type) ? job_type : [job_type]).filter((t) => t != null && t !== "");
        if (types.length > 0) query.whereIn("job_type", types);
      }
      if (exclude !== "work_mode" && work_mode) {
        const modes = (Array.isArray(work_mode) ? work_mode : [work_mode]).filter((m) => m != null && m !== "");
        if (modes.length > 0) query.whereIn("work_mode", modes);
      }
      if (exclude !== "job_city" && job_city) {
        const cities = (Array.isArray(job_city) ? job_city : [job_city]).filter((c) => c != null && c !== "");
        if (cities.length > 0) query.whereIn("job_city", cities);
      }
      if (exclude !== "q" && filterSearchTerm) {
        const term =
          "%" + filterSearchTerm.replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
        query.andWhereRaw(
          '("jobName" ilike ? OR "companyName" ilike ? OR COALESCE("jobDescription", \'\') ilike ?)',
          [term, term, term]
        );
      }
      return query;
    };

    const [categoryRows, salary1000, salary2000, salary3000, salary4000, salary5000, salary6000, expRows, typeRows, workModeRows, cityRows] =
      await Promise.all([
        applyOtherFilters(baseQuery().clone(), "category")
          .select("category_id")
          .count("* as c")
          .groupBy("category_id"),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 1000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 2000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 3000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 4000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 5000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 6000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone(), "job_experience")
          .select("job_experience")
          .count("* as c")
          .groupBy("job_experience"),
        applyOtherFilters(baseQuery().clone(), "job_type")
          .select("job_type")
          .count("* as c")
          .groupBy("job_type"),
        applyOtherFilters(baseQuery().clone(), "work_mode")
          .select("work_mode")
          .count("* as c")
          .groupBy("work_mode"),
        applyOtherFilters(baseQuery().clone(), "job_city")
          .whereIn("job_city", ["თბილისი", "ქუთაისი", "ბათუმი", "ზუგდიდი", "გორი", "რუსთავი", "მცხეთა", "თელავი", "მესტია", "ფოთი", "ჭიათურა", "ზესტაფონი", "მარნეული"])
          .select("job_city")
          .count("* as c")
          .groupBy("job_city"),
      ]);

    const categoryCounts = {};
    (categoryRows || []).forEach((r) => {
      categoryCounts[String(r.category_id)] = parseInt(r.c, 10) || 0;
    });

    const salaryCounts = {
      "1000": parseInt(salary1000?.c, 10) || 0,
      "2000": parseInt(salary2000?.c, 10) || 0,
      "3000": parseInt(salary3000?.c, 10) || 0,
      "4000": parseInt(salary4000?.c, 10) || 0,
      "5000": parseInt(salary5000?.c, 10) || 0,
      "6000": parseInt(salary6000?.c, 10) || 0,
    };

    const experienceCounts = {};
    (expRows || []).forEach((r) => {
      if (r.job_experience) experienceCounts[String(r.job_experience)] = parseInt(r.c, 10) || 0;
    });

    const jobTypeCounts = {};
    (typeRows || []).forEach((r) => {
      if (r.job_type) jobTypeCounts[String(r.job_type)] = parseInt(r.c, 10) || 0;
    });

    const workModeCounts = {};
    (workModeRows || []).forEach((r) => {
      if (r.work_mode) workModeCounts[String(r.work_mode)] = parseInt(r.c, 10) || 0;
    });

    const cityCounts = {};
    (cityRows || []).forEach((r) => {
      if (r.job_city) cityCounts[String(r.job_city)] = parseInt(r.c, 10) || 0;
    });

    const result = {
      category: categoryCounts,
      min_salary: salaryCounts,
      job_experience: experienceCounts,
      job_type: jobTypeCounts,
      work_mode: workModeCounts,
      job_city: cityCounts,
    };
    setFilterCounts(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("filter-counts error:", err.message, "query params:", req.query);
    res.status(500).json({ error: err.message });
  }
});

// Lazy-loaded home sections (today's jobs, main jobs area) – used for below-fold content
app.get("/api/home/section", async (req, res) => {
  try {
    const { section } = req.query;
    if (!section || !["today", "main"].includes(section)) {
      return res.status(400).send("Missing or invalid section");
    }

    const {
      category,
      company,
      job_experience,
      job_type,
      work_mode,
      job_city,
      page = 1,
      limit: limitParam = 5,
      hasSalary,
      job_premium_status,
      min_salary,
      q: searchQuery,
    } = req.query;

    const limit = Number(limitParam);
    const pageNum = Number(page);

    const filterParamKeys = [
      "category",
      "company",
      "job_experience",
      "job_type",
      "work_mode",
      "job_city",
      "hasSalary",
      "job_premium_status",
      "min_salary",
      "q",
    ];
    const filtersActive = filterParamKeys.some((key) => {
      const v = req.query[key];
      if (v === undefined || v === "") return false;
      return Array.isArray(v) ? v.length > 0 : true;
    });

    if (section === "today") {
      if (filtersActive) {
        // Today's section is hidden when filters are active – return empty hidden fragment
        return res.type("text/html").send('<section id="today-jobs-section" class="hidden" style="display:none"></section>');
      }
      let todayJobs = await db("jobs")
        .select(...JOBS_LIST_COLUMNS)
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
        .whereRaw(`${DATE_IN_GEORGIA} = ${TODAY_IN_GEORGIA}`)
        .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc");
      const seenToday = new Set();
      todayJobs = todayJobs.filter((j) => {
        const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
        if (seenToday.has(key)) return false;
        seenToday.add(key);
        return true;
      });
      const todayJobsCount = todayJobs.length;
      req.app.render(
        "partials/homeTodaySection",
        { todayJobs, todayJobsCount, slugify, filtersActive },
        (err, html) => {
          if (err) return res.status(500).send(err.message);
          res.type("text/html").send(html);
        }
      );
      return;
    }

    if (section === "main") {
      let query = db("jobs")
        .select(...JOBS_LIST_COLUMNS)
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
      let countQuery = db("jobs")
        .count("* as total")
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
      if (!filtersActive) {
        query.whereRaw(`${DATE_IN_GEORGIA} < ${TODAY_IN_GEORGIA}`);
        countQuery.whereRaw(`${DATE_IN_GEORGIA} < ${TODAY_IN_GEORGIA}`);
      }
      if (company) {
        query.where("companyName", company);
        countQuery.where("companyName", company);
      }
      if (category) {
        const cats = Array.isArray(category) ? category : [category];
        query.whereIn("category_id", cats);
        countQuery.whereIn("category_id", cats);
      }
      if (job_experience) {
        const exp = Array.isArray(job_experience) ? job_experience : [job_experience];
        query.whereIn("job_experience", exp);
        countQuery.whereIn("job_experience", exp);
      }
      if (min_salary) {
        const salaries = (Array.isArray(min_salary) ? min_salary : [min_salary]).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
        if (salaries.length > 0) {
          const min = Math.min(...salaries);
          query.where("jobSalary_min", ">=", min);
          countQuery.where("jobSalary_min", ">=", min);
        }
      }
      if (job_type) {
        const types = Array.isArray(job_type) ? job_type : [job_type];
        query.whereIn("job_type", types);
        countQuery.whereIn("job_type", types);
      }
      if (work_mode) {
        const modes = Array.isArray(work_mode) ? work_mode : [work_mode];
        query.whereIn("work_mode", modes);
        countQuery.whereIn("work_mode", modes);
      }
      if (job_city) {
        const cities = Array.isArray(job_city) ? job_city : [job_city];
        query.whereIn("job_city", cities);
        countQuery.whereIn("job_city", cities);
      }
      if (hasSalary === "true") {
        query.whereNotNull("jobSalary");
        countQuery.whereNotNull("jobSalary");
      }
      if (job_premium_status) {
        const premium = Array.isArray(job_premium_status) ? job_premium_status : [job_premium_status];
        query.whereIn("job_premium_status", premium);
        countQuery.whereIn("job_premium_status", premium);
      }
      if (searchQuery && typeof searchQuery === "string" && searchQuery.trim()) {
        const term =
          "%" +
          searchQuery.trim().replace(/%/g, "\\%").replace(/_/g, "\\_") +
          "%";
        query.andWhereRaw(
          '("jobName" ilike ? OR "companyName" ilike ? OR COALESCE("jobDescription", \'\') ilike ?)',
          [term, term, term]
        );
        countQuery.andWhereRaw(
          '("jobName" ilike ? OR "companyName" ilike ? OR COALESCE("jobDescription", \'\') ilike ?)',
          [term, term, term]
        );
      }

      const [{ total }] = await countQuery;
      const totalPages = Math.ceil(total / limit);
      const PREMIUM_PRIORITIZE_ORDER = `CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`;
      let jobs = await query
        .orderByRaw(PREMIUM_PRIORITIZE_ORDER)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(pageNum * limit)
        .offset((pageNum - 1) * limit);

      const seenKey = new Set();
      jobs = jobs.filter((j) => {
        const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
        if (seenKey.has(key)) return false;
        seenKey.add(key);
        return true;
      });

      const paginationBase = "/";
      req.app.render(
        "partials/homeJobsArea",
        { jobs, currentPage: pageNum, totalPages, filtersActive, paginationBase, slugify },
        (err, html) => {
          if (err) return res.status(500).send(err.message);
          res.type("text/html").send(html);
        }
      );
      return;
    }

    res.status(400).send("Invalid section");
  } catch (err) {
    console.error("api/home/section error:", err);
    res.status(500).send(err.message);
  }
});

app.post("/api/auth/google", async (req, res) => {
  const { access_token } = req.body;

  try {
    // 1) Verify token with Google
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${access_token}` },
      },
    );

    const userInfo = await response.json();

    // 2) Create / update user in our own users service / API
    const USERS_SERVICE_URL =
      process.env.USERS_SERVICE_URL || "http://localhost:4001";

    const authResponse = await fetch(`${USERS_SERVICE_URL}/users/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_uid: userInfo.sub,
        user_name: userInfo.name,
        user_email: userInfo.email,
        user_type: "user",
      }),
    });

    const authData = await authResponse.json();

    req.session.user = {
      uid: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      user_type: (() => {
        const t = authData.user?.user_type ?? authData.user_type ?? "user";
        return t === "pending" || t == null || t === "" ? "user" : t;
      })(),
    };

    res.json({ success: true });
  } catch (error) {
    console.error("Auth error:", error);
    res.status(401).json({ success: false, error: error.message });
  }
});

// logout
app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
    }
    res.redirect("/");
  });
});
// jobs router
const jobsRouter = require("./routes/jobs")(db);
app.get("/jobs/email-queue-status", async (req, res) => {
  const status = await jobsRouter.getEmailQueueStatus();
  res.json(status);
});
app.get("/jobs/email-queue-details", async (req, res) => {
  const details = await jobsRouter.getEmailQueueDetails();
  res.json(details);
});
app.get("/jobs/premium-low-cv-candidates", async (req, res) => {
  try {
    const data = await jobsRouter.getPremiumLowCvCandidatesData();
    res.json(data);
  } catch (err) {
    console.error("premium-low-cv-candidates error:", err);
    res.status(500).json({ error: err.message });
  }
});
app.post("/jobs/email-queue-kick", async (req, res) => {
  jobsRouter.kickEmailQueue();
  const status = await jobsRouter.getEmailQueueStatus();
  res.json({ ok: true, pending: status.pending });
});
app.post("/jobs/requeue-new-job-emails", async (req, res) => {
  try {
    const { jobIds } = req.body || {};
    const result = await jobsRouter.requeueJobsByIds(jobIds);
    res.json(result);
  } catch (err) {
    console.error("requeue-new-job-emails error:", err);
    res.status(500).json({ error: err.message });
  }
});
app.use("/jobs", jobsRouter);

// users router
app.use("/users", require("./routes/users")(db));

// GET /api/users/:userId/resume – return user's resume by user_id (user_uid) or users.id
app.get("/api/users/:userId/resume", async (req, res) => {
  try {
    const { userId } = req.params;
    let resolvedUserUid = String(userId);
    let resume = await db("resumes")
      .where("user_id", userId)
      .orderBy("updated_at", "desc")
      .select(
        "id",
        "user_id",
        "file_url",
        "file_name",
        "created_at",
        "updated_at",
        "created_cv_on_samushao_ge"
      )
      .first();
    // If not found, userId might be users.id (numeric) – resolve to user_uid only when it's a safe 32-bit int
    if (!resume) {
      const numericId = Number(userId);
      const isValidIntId =
        Number.isInteger(numericId) && numericId > 0 && numericId <= 2147483647;
      if (isValidIntId) {
        const user = await db("users").where("id", numericId).select("user_uid").first();
        if (user) {
          resolvedUserUid = String(user.user_uid);
          resume = await db("resumes")
            .where("user_id", user.user_uid)
            .orderBy("updated_at", "desc")
            .select(
              "id",
              "user_id",
              "file_url",
              "file_name",
              "created_at",
              "updated_at",
              "created_cv_on_samushao_ge"
            )
            .first();
        }
      }
    }
    if (!resume) {
      return res.status(404).json({ error: "Resume not found" });
    }
    const aiRow = await db("resumes")
      .where("user_id", resolvedUserUid)
      .andWhere(function () {
        this.where("created_cv_on_samushao_ge", true).orWhereNotNull("cv_html");
      })
      .first();

    res.json({
      ...resume,
      has_samushao_cv: !!aiRow,
    });
  } catch (err) {
    console.error("api/users/:userId/resume error:", err);
    res.status(500).json({ error: err.message });
  }
});

// resumes router
app.use("/resumes", require("./routes/resumes")(db));

// categories router
app.use("/categories", require("./routes/categories")(db));

// company logos router
app.use("/upload-logo", require("./routes/company_logos")(db));

// send cv router
app.use("/send-cv", require("./routes/sendCv")(db));

// Job form submission (alternative to CV)
app.use("/submit-job-form", require("./routes/jobFormSubmit")(db));

// User without CV banner: submit form (saves to DB, sets cookie)
app.post("/api/user-without-cv", async (req, res) => {
  if (req.session?.user) {
    return res.status(400).json({ error: "Only for non-authenticated users" });
  }
  const { name, email, phone, short_description, categories, other_specify } = req.body || {};
  const trimmedName = (name || "").toString().trim();
  const trimmedPhone = (phone || "").toString().trim();
  if (!trimmedName) return res.status(400).json({ error: "სახელი აუცილებელია" });
  if (!trimmedPhone) return res.status(400).json({ error: "ტელეფონის ნომერი აუცილებელია" });
  const row = {
    name: trimmedName,
    email: (email || "").toString().trim() || null,
    phone: trimmedPhone,
    short_description: (short_description || "").toString().trim() || null,
    categories: Array.isArray(categories) ? categories.join(",") : (categories || "").toString().trim() || null,
    other_specify: (other_specify || "").toString().trim() || null,
  };
  try {
    const [inserted] = await db("user_without_cv").insert(row).returning("id");
    const id = inserted?.id ?? inserted;
    if (id && (process.env.PINECONE_API_KEY || "").trim()) {
      const { upsertUserWithoutCv } = require("./services/pineconeCandidates");
      const cats = Array.isArray(categories) ? categories : (row.categories || "").split(",").map((s) => s.trim()).filter(Boolean);
      upsertUserWithoutCv(id, {
        name: trimmedName,
        email: row.email || "",
        phone: trimmedPhone,
        short_description: row.short_description || "",
        categories: cats,
        other_specify: row.other_specify || "",
      }).catch((err) => console.error("[pinecone] user-without-cv upsert error:", err?.message));
    }
    res.cookie(NO_CV_BANNER_COOKIE, "1", {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("user-without-cv error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Admin: users registered per day. Default: today + 6 previous days (7 total). ?days=N = N days total; ?from=&to= for range.
app.get("/api/admin/users-registrations-by-day", async (req, res) => {
  try {
    const TZ = TZ_GEORGIA;
    const fromParam = String(req.query.from || "").trim();
    const toParam = String(req.query.to || "").trim();
    const daysParam = parseInt(req.query.days, 10);

    let startDate;
    let endDate;
    if (fromParam && toParam) {
      startDate = fromParam;
      endDate = toParam;
    } else {
      // n = number of days before today; total days = n + 1 (today + n previous). Default 7 days = today + 6 previous.
      const n = (!Number.isNaN(daysParam) && daysParam > 0) ? Math.min(daysParam - 1, 364) : 6;
      const { rows: dateRow } = await db.raw(
        "SELECT to_char((NOW() AT TIME ZONE ?)::date, 'YYYY-MM-DD') AS today",
        [TZ]
      );
      const todayStr = dateRow?.[0]?.today ? String(dateRow[0].today).trim() : null;
      if (!todayStr || !/^\d{4}-\d{2}-\d{2}$/.test(todayStr)) {
        return res.status(500).json({ error: "Could not get today date" });
      }
      endDate = todayStr;
      const end = new Date(todayStr + "T12:00:00.000Z");
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - n);
      startDate = start.toISOString().slice(0, 10);
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ error: "Invalid date range" });
    }

    // created_at is stored as UTC (timestamp or timestamptz); convert to Georgia date for grouping
    const dateInGeorgia = "(users.created_at AT TIME ZONE 'UTC' AT TIME ZONE ?)::date";
    const { rows: countRows } = await db.raw(
      `SELECT to_char(${dateInGeorgia}, 'YYYY-MM-DD') AS date, COUNT(users.id)::int AS count
       FROM users
       WHERE ${dateInGeorgia} >= ?::date
         AND ${dateInGeorgia} <= ?::date
       GROUP BY 1
       ORDER BY 1 ASC`,
      [TZ, TZ, startDate, TZ, endDate]
    );
    const countByDate = Object.fromEntries(
      (countRows || []).map((r) => [String(r.date).trim(), parseInt(r.count, 10) || 0])
    );

    const items = [];
    const cur = new Date(startDate + "T12:00:00.000Z");
    const end = new Date(endDate + "T12:00:00.000Z");
    if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(500).json({ error: "Invalid date range" });
    }
    for (; cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
      const d = cur.toISOString().slice(0, 10);
      items.push({ date: d, count: countByDate[d] ?? 0 });
    }

    const total = items.reduce((sum, i) => sum + i.count, 0);
    res.json({ items, total });
  } catch (err) {
    console.error("admin users-registrations-by-day error:", err);
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

// Admin: list candidates without CV (user_without_cv submissions)
app.get("/api/admin/user-without-cv", async (req, res) => {
  try {
    const rows = await db("user_without_cv")
      .select("*")
      .orderBy("created_at", "desc");
    res.json({ items: rows });
  } catch (err) {
    console.error("admin user-without-cv list error:", err);
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

// User without CV banner: dismiss (record in DB, set 30-day cookie – show again after month)
app.post("/api/user-without-cv/dismiss", async (req, res) => {
  if (req.session?.user) return res.json({ ok: true });
  try {
    if (req.visitorId) {
      await db("no_cv_banner_dismissals").insert({
        visitor_id: req.visitorId,
        dismissed_at: db.fn.now(),
      });
    }
  } catch (err) {
    console.error("no_cv_banner_dismissals insert error:", err?.message);
  }
  res.cookie(NO_CV_BANNER_COOKIE, "1", {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  res.json({ ok: true });
});

// Visitors API
app.post("/api/visitors/record-duration", async (req, res) => {
  try {
    if (!req.visitorId) return res.status(400).json({ error: "No visitor" });
    const jobId = parseInt(req.body?.job_id, 10);
    const seconds = Math.max(0, parseInt(req.body?.duration_seconds, 10));
    if (!jobId || isNaN(jobId)) return res.status(400).json({ error: "Invalid job_id" });
    const subq = db("visitor_job_clicks")
      .select("id")
      .where({ visitor_id: req.visitorId, job_id: jobId })
      .orderBy("clicked_at", "desc")
      .limit(1);
    await db("visitor_job_clicks")
      .whereIn("id", subq)
      .update({ time_spent_seconds: isNaN(seconds) ? null : seconds });
    res.status(204).send();
  } catch (err) {
    console.error("visitors/record-duration error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Temporary: inspect CV creator chat logs (Gemini CV creator)
app.get("/tmp/cv-creator-logs", async (req, res) => {
  try {
    const rows = await db("cv_creator_chat_logs as l")
      .leftJoin("users as u", "l.user_id", "u.user_uid")
      .select(
        "l.id",
        "l.session_id",
        "l.user_id",
        "u.user_name",
        "l.turn_index",
        "l.had_existing_cv",
        "l.user_message",
        "l.assistant_reply",
        "l.cv_data",
        "l.created_at"
      )
      .orderBy("l.created_at", "desc");

    res.json({ items: rows });
  } catch (err) {
    console.error("tmp cv-creator-logs error:", err);
    res.status(500).json({ error: err.message || "Failed to load logs" });
  }
});

app.get("/api/visitors", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const [visitors, countRes] = await Promise.all([
      db("visitors")
        .select(
          "visitors.*",
          db.raw(
            "(SELECT COUNT(*)::int FROM visitor_job_clicks WHERE visitor_id = visitors.id) as job_clicks_count"
          ),
          db.raw(
            "(SELECT COUNT(*)::int FROM job_applications WHERE visitor_id = visitors.id) as cv_count"
          )
        )
        .orderByRaw("(CASE WHEN visitors.visit_count > 2 THEN 1 ELSE 0 END) DESC")
        .orderByRaw("job_clicks_count DESC")
        .orderByRaw("cv_count DESC")
        .limit(limit)
        .offset(offset),
      db("visitors").count("* as total"),
    ]);
    const total = Number((countRes[0] && countRes[0].total) || 0);

    const visitorIds = visitors.map((v) => v.id);
    const [clicks, applications] = await Promise.all([
      visitorIds.length
        ? db("visitor_job_clicks")
            .whereIn("visitor_id", visitorIds)
            .select("*")
            .orderBy("clicked_at", "desc")
        : [],
      visitorIds.length
        ? db("job_applications")
            .whereIn("visitor_id", visitorIds)
            .whereNotNull("visitor_id")
            .select("*")
        : [],
    ]);

    const clicksByVisitor = {};
    clicks.forEach((c) => {
      if (!clicksByVisitor[c.visitor_id]) clicksByVisitor[c.visitor_id] = [];
      clicksByVisitor[c.visitor_id].push(c);
    });
    const applicationsByVisitor = {};
    applications.forEach((a) => {
      if (!applicationsByVisitor[a.visitor_id]) applicationsByVisitor[a.visitor_id] = [];
      applicationsByVisitor[a.visitor_id].push(a);
    });

    const result = visitors.map((v) => {
      const { job_clicks_count, cv_count, ...rest } = v;
      return {
        ...rest,
        is_registered: !!v.user_id,
        job_clicks_count: Number(job_clicks_count) || 0,
        cv_count: Number(cv_count) || 0,
        job_clicks: (clicksByVisitor[v.id] || []).map((c) => ({
          ...c,
          time_spent_seconds: c.time_spent_seconds ?? null,
        })),
        cv_submissions: applicationsByVisitor[v.id] || [],
      };
    });

    res.json({
      visitors: result,
      total: Number(total),
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("api/visitors error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.use("/uploads", express.static("uploads"));

// Catch-all 404 (must be after all routes)
app.use((req, res) => {
  res.status(404).render("404", { message: "გვერდი ვერ მოიძებნა." });
});

// Sentry error handler (only if DSN is configured)
Sentry.setupExpressErrorHandler(app);
  app.use(function onError(err, req, res, next) {
    // The error id is attached to `res.sentry` to be returned
    // and optionally displayed to the user for support.
    res.statusCode = 500;
    res.end(res.sentry + "\n");
  });

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  runPremiumExpiryCleanup().catch(() => {});
  setInterval(
    () => runPremiumExpiryCleanup().catch(() => {}),
    PREMIUM_EXPIRY_CLEANUP_INTERVAL_MS,
  );
});

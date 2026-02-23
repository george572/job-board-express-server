/**
 * Gemini-based assessment of how well a candidate's CV aligns with a job.
 * Used when retrieving top candidates in admin (optional assessWithGemini=1).
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * Assess alignment between job and candidate CV text using Gemini.
 *
 * @param {object} job - Job record: jobName, companyName, jobDescription, job_experience, job_type, job_city, jobSalary
 * @param {string} cvText - Extracted text from candidate's CV (plain text)
 * @returns {Promise<{ fit_score: number, summary: string, verdict: string }>}
 */
async function assessCandidateAlignment(job, cvText) {
  const apiKey =
    process.env.GEMINI_CV_READER_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_CV_READER_API_KEY or GEMINI_API_KEY is missing in .env"
    );
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

  const jobDesc = (job.jobDescription || job.job_description || "").trim();
  const jobDetails = [
    `Job title: ${job.jobName || "N/A"}`,
    `Company: ${job.companyName || "N/A"}`,
    `City: ${job.job_city || "N/A"}`,
    `Experience required: ${job.job_experience || "N/A"}`,
    `Job type: ${job.job_type || "N/A"}`,
    `Salary: ${job.jobSalary || "N/A"}`,
    "",
    "Job description (full text – use it; do not claim it is missing or lacks detail):",
    jobDesc || "N/A",
  ].join("\n");

  const jobCity = (job.job_city || "").trim();
  const cityRule = jobCity
    ? `CITY RULE: The job is in "${jobCity}". If the CV mentions the candidate's city and it does NOT match "${jobCity}", fit_score cannot exceed 25 (WEAK_MATCH). If the CV does not mention any city/location, note "ქალაქი CV-ში არ არის მითითებული" in the summary but do NOT penalize the score for it.`
    : "";

  const prompt = `You are an elite recruiter. Analyze how well the candidate's CV aligns with the job below. The job description is complete – do NOT say the job post lacked a detailed description. When assessing, ignore candidates' personal soft skill claims like being able to work under stress.
Summary output must be in Georgian (ქართული ენა).

Job details:
${jobDetails}

---

Candidate CV (text extracted from resume):
${(cvText || "").slice(0, 12000)}

---

SCORING (0-100):
1. Core skills/experience match (50%): Direct experience with tools, languages, or roles requested.
2. Years/level of experience (25%): Meets or exceeds seniority required.
3. Industry relevance (15%): Similar sector or domain experience.
4. Education/soft skills (10%): Degree or communication fit.

If a mandatory requirement is clearly missing (e.g. JD asks for Java, candidate has none), fit_score cannot exceed 30.
${cityRule}

Write the summary in Georgian (ქართული ენა). Respond in this exact JSON format (no other text):
{"fit_score": <0-100>, "summary": "<2-3 sentence explanation in Georgian>", "verdict": "STRONG_MATCH"|"GOOD_MATCH"|"PARTIAL_MATCH"|"WEAK_MATCH"}

Verdict mapping: 80-100=STRONG_MATCH, 60-79=GOOD_MATCH, 40-59=PARTIAL_MATCH, 0-39=WEAK_MATCH`;

  const result = await model.generateContent(prompt);
  const response = result.response;
  if (!response || !response.text) {
    throw new Error("Empty response from Gemini");
  }

  const text = response.text().trim();
  // Extract JSON (handle markdown code blocks)
  let jsonStr = text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];

  try {
    const parsed = JSON.parse(jsonStr);
    const fit_score = Math.min(100, Math.max(0, Number(parsed.fit_score) || 0));
    const summary = String(parsed.summary || "").trim() || "No summary.";
    const verdict =
      parsed.verdict && ["STRONG_MATCH", "GOOD_MATCH", "PARTIAL_MATCH", "WEAK_MATCH"].includes(parsed.verdict)
        ? parsed.verdict
        : fit_score >= 80
          ? "STRONG_MATCH"
          : fit_score >= 60
            ? "GOOD_MATCH"
            : fit_score >= 40
              ? "PARTIAL_MATCH"
              : "WEAK_MATCH";
    return { fit_score, summary, verdict };
  } catch (e) {
    // Fallback: try to extract score and verdict from raw text
    const scoreMatch = text.match(/fit_score["\s:]+(\d+)/i) || text.match(/(\d+)\s*%\s*(?:fit|match)/i);
    const verdictMatch = text.match(/(STRONG_MATCH|GOOD_MATCH|PARTIAL_MATCH|WEAK_MATCH)/i);
    const fit_score = scoreMatch ? Math.min(100, Math.max(0, parseInt(scoreMatch[1], 10))) : 50;
    const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : (fit_score >= 60 ? "GOOD_MATCH" : "PARTIAL_MATCH");
    const summary = text.slice(0, 300).replace(/\n/g, " ").trim();
    return { fit_score, summary, verdict };
  }
}

/**
 * Assess alignment between job and no-CV candidate (based on short_description, categories, other_specify).
 * Judge based on what they say they know and their chosen categories.
 *
 * @param {object} job - Job record: jobName, jobDescription, job_experience, job_type, job_city
 * @param {object} noCvRow - user_without_cv: { name, short_description, categories, other_specify }
 * @returns {Promise<{ fit_score: number, summary: string, verdict: string }>}
 */
async function assessNoCvAlignment(job, noCvRow) {
  const apiKey =
    process.env.GEMINI_CV_READER_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_CV_READER_API_KEY or GEMINI_API_KEY is missing in .env"
    );
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

  const jobDesc = (job.jobDescription || job.job_description || "").trim();
  const jobDetails = [
    `Job title: ${job.jobName || "N/A"}`,
    `City: ${job.job_city || "N/A"}`,
    `Experience required: ${job.job_experience || "N/A"}`,
    `Job type: ${job.job_type || "N/A"}`,
    "",
    "Job description (full – use it; do not claim it lacks detail):",
    jobDesc || "N/A",
  ].join("\n");

  const desc = (noCvRow.short_description || "").toString().trim();
  const cats = (noCvRow.categories || "").toString().trim();
  const other = (noCvRow.other_specify || "").toString().trim();
  const name = (noCvRow.name || "").toString().trim();

  const candidateInfo = [
    `Name: ${name || "—"}`,
    `What they say they know / experience: ${desc || "Not provided"}`,
    `Categories they're interested in: ${cats || "Not specified"}`,
    other ? `Other: ${other}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const jobCity = (job.job_city || "").trim();
  const cityRule = jobCity
    ? `CITY RULE: The job is in "${jobCity}". If the candidate mentions their city and it does NOT match "${jobCity}", fit_score cannot exceed 25 (WEAK_MATCH). If the candidate does not mention any city/location, note "ქალაქი არ არის მითითებული" in the summary but do NOT penalize the score for it.`
    : "";

  const prompt = `You are an elite recruiter. A candidate WITHOUT a CV filled out a short form. Judge how well they might fit the job based on:
1) What they say they know and their experience (short_description)
2) The categories they chose (these indicate their interests/skills area)

Summary output must be in Georgian (ქართული ენა). Be concise – 2-3 sentences max.
Do NOT say things like "I could not see more categories" or that information is limited. Base your assessment only on what is provided.

Job details:
${jobDetails}

---

Candidate info (no CV, form submission only):
${candidateInfo}

---

SCORING (0-100):
1. Relevance of stated skills/experience to job (50%)
2. Category overlap with job requirements (30%)
3. General fit / potential (20%)

${cityRule}

Verdict mapping: 80-100=STRONG_MATCH, 60-79=GOOD_MATCH, 40-59=PARTIAL_MATCH, 0-39=WEAK_MATCH

Respond in this exact JSON format (no other text):
{"fit_score": <0-100>, "summary": "<2-3 sentence explanation in Georgian>", "verdict": "STRONG_MATCH"|"GOOD_MATCH"|"PARTIAL_MATCH"|"WEAK_MATCH"}`;

  const result = await model.generateContent(prompt);
  const response = result.response;
  if (!response || !response.text) {
    throw new Error("Empty response from Gemini");
  }

  const text = response.text().trim();
  let jsonStr = text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];

  try {
    const parsed = JSON.parse(jsonStr);
    const fit_score = Math.min(100, Math.max(0, Number(parsed.fit_score) || 0));
    const summary = String(parsed.summary || "").trim() || "No summary.";
    const verdict =
      parsed.verdict &&
      ["STRONG_MATCH", "GOOD_MATCH", "PARTIAL_MATCH", "WEAK_MATCH"].includes(
        parsed.verdict
      )
        ? parsed.verdict
        : fit_score >= 80
          ? "STRONG_MATCH"
          : fit_score >= 60
            ? "GOOD_MATCH"
            : fit_score >= 40
              ? "PARTIAL_MATCH"
              : "WEAK_MATCH";
    return { fit_score, summary, verdict };
  } catch (e) {
    const scoreMatch =
      text.match(/fit_score["\s:]+(\d+)/i) ||
      text.match(/(\d+)\s*%\s*(?:fit|match)/i);
    const verdictMatch = text.match(
      /(STRONG_MATCH|GOOD_MATCH|PARTIAL_MATCH|WEAK_MATCH)/i
    );
    const fit_score = scoreMatch
      ? Math.min(100, Math.max(0, parseInt(scoreMatch[1], 10)))
      : 50;
    const verdict = verdictMatch
      ? verdictMatch[1].toUpperCase()
      : fit_score >= 60
        ? "GOOD_MATCH"
        : "PARTIAL_MATCH";
    const summary = text.slice(0, 300).replace(/\n/g, " ").trim();
    return { fit_score, summary, verdict };
  }
}

module.exports = { assessCandidateAlignment, assessNoCvAlignment };

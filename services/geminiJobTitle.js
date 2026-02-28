/**
 * Generate/extract a job title from a job description using Gemini.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { GoogleGenerativeAI } = require("@google/generative-ai");

async function generateJobTitleFromDescription(jobDescription) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_CV_READER_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY or GEMINI_CV_READER_API_KEY is missing in .env");
  }

  const text = (jobDescription || "").toString().trim();
  if (!text || text.length < 20) return "";

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

  const prompt = `Task: Extract or guess the job title from the job description below.

Rules:
- If the title is explicitly present, return it (cleaned).
- If not, guess the most likely role based on responsibilities/requirements.
- Output MUST be a single line title only (no quotes, no punctuation at end, no markdown, no labels).
- Keep the language of the original description (Georgian if Georgian; English if English).
- Do not include company name, location, salary, contact info.
- Max 80 characters.

Job description:
${text.slice(0, 12000)}`;

  const result = await model.generateContent(prompt);
  const response = result?.response;
  if (!response || !response.text) {
    throw new Error("Empty response from Gemini");
  }
  let title = response.text().trim();
  title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
  title = title.replace(/^```[\s\S]*?\n/i, "").replace(/```$/i, "").trim();
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/[.!?၊။]+$/u, "").trim();
  if (title.length > 80) title = title.slice(0, 80).trim();
  return title;
}

module.exports = { generateJobTitleFromDescription };


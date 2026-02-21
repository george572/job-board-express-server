/**
 * Generate AI (Gemini) description for user_without_cv rows.
 * Output is a short professional summary in Georgian.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { GoogleGenerativeAI } = require("@google/generative-ai");

/**
 * Generate a 2-3 sentence professional summary for a no-CV candidate.
 *
 * @param {object} row - user_without_cv: { name, short_description, categories, other_specify }
 * @returns {Promise<string>} AI-generated description in Georgian
 */
async function generateNoCvDescription(row) {
  const apiKey =
    process.env.GEMINI_CV_READER_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_CV_READER_API_KEY or GEMINI_API_KEY is missing");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

  const cats = (row.categories || "").toString().trim();
  const desc = (row.short_description || "").toString().trim();
  const other = (row.other_specify || "").toString().trim();
  const name = (row.name || "").toString().trim();

  const prompt = `You are a recruiter. Based on the following candidate information, write a brief professional summary in Georgian (ქართული ენა). 2-3 sentences max. Focus on their profile, interests, and what they can offer. Be concise and professional.

Candidate info:
- Name: ${name}
- Short description: ${desc || "Not provided"}
- Categories they're interested in: ${cats || "Not specified"}
- Other (specify): ${other || "—"}

Respond with ONLY the summary text, no labels or JSON. Georgian language only.`;

  const result = await model.generateContent(prompt);
  const response = result.response;
  if (!response || !response.text) {
    throw new Error("Empty response from Gemini");
  }
  return response.text().trim().slice(0, 1000);
}

module.exports = { generateNoCvDescription };

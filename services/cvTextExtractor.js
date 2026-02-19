/**
 * Extracts raw text from CV files (PDF, DOC, DOCX).
 * CVs are stored on Cloudinary; we fetch by URL and parse.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");

const MIN_TEXT_LENGTH = 50; // Reject very short extractions (likely failed parse)

/**
 * Fetch file buffer from URL (Cloudinary or any HTTP URL)
 */
async function fetchFileBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch CV: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Extract text from PDF buffer (pdf-parse v2 API)
 */
async function extractFromPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return (result?.text || "").trim();
  } finally {
    await parser.destroy();
  }
}

/**
 * Extract text from DOC/DOCX buffer
 */
async function extractFromDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return (result.value || "").trim();
}

/**
 * Extract text from a CV file given its URL.
 * Supports PDF, DOC, DOCX. Returns empty string if unsupported or extraction fails.
 *
 * @param {string} fileUrl - Cloudinary or HTTP URL to the CV file
 * @param {string} [fileName] - Optional original file name (e.g. "resume.pdf") for format detection
 * @returns {Promise<string>} Extracted text, or empty string on failure
 */
async function extractTextFromCv(fileUrl, fileName) {
  if (!fileUrl || typeof fileUrl !== "string") return "";

  try {
    const buffer = await fetchFileBuffer(fileUrl);
    const ext = (fileName || fileUrl).toLowerCase().split(".").pop();

    let text = "";
    if (ext === "pdf") {
      text = await extractFromPdf(buffer);
    } else if (ext === "docx" || ext === "doc") {
      text = await extractFromDocx(buffer);
    } else {
      // Try PDF first (Cloudinary URLs may not have extension), then DOCX
      try {
        text = await extractFromPdf(buffer);
      } catch {
        text = await extractFromDocx(buffer);
      }
    }

    const cleaned = (text || "").replace(/\s+/g, " ").trim();
    if (cleaned.length < MIN_TEXT_LENGTH) {
      throw new Error("no text extracted (text too short or empty)");
    }
    return cleaned;
  } catch (err) {
    console.warn("[cvTextExtractor] Extraction failed:", err.message);
    throw err;
  }
}

module.exports = { extractTextFromCv, fetchFileBuffer };

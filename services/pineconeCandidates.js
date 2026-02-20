/**
 * Pinecone candidate–job matching using multilingual-e5-large embeddings.
 *
 * Flow:
 * - Phase 1: Backfill – extract CV text, upsert as text records (Pinecone embeds them)
 * - Phase 2/4: On CV upload/update – extract text, upsert (overwrites by id)
 * - Phase 3: On job post – search by job description + metadata, rerank, get top K
 *
 * Index must use multilingual-e5-large. Create via: node scripts/create-pinecone-index-e5.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Pinecone } = require("@pinecone-database/pinecone");
const { extractTextFromCv } = require("./cvTextExtractor");

const NAMESPACE = "candidates";
const JINA_API_KEY = (process.env.JINA_API_KEY || "").trim();

let _pinecone = null;

async function embedWithJina(texts, task) {
  if (!JINA_API_KEY) throw new Error("JINA_API_KEY is required for Jina embeddings");
  const res = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${JINA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: "jina-embeddings-v3",
      task, // "retrieval.passage" or "retrieval.query"
      dimensions: 1024,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jina embed failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  return (json.data || []).map((d) => d.embedding);
}

function normalizeForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9\u10A0-\u10FF\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRoleTokens(role) {
  const norm = normalizeForMatch(role);
  if (!norm) return { phrase: "", tokens: [] };
  const tokens = Array.from(
    new Set(
      norm
        .split(" ")
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !/^\d+$/.test(t))
    )
  );
  return { phrase: norm, tokens };
}

function candidateHasRoleExperience(candidateText, role) {
  const cand = normalizeForMatch(candidateText);
  if (!cand) return false;

  const { phrase, tokens } = buildRoleTokens(role);
  if (!phrase) return true; // no role to enforce

  // Strong signal: full phrase appears.
  if (phrase.length >= 6 && cand.includes(phrase)) return true;

  // Fallback: require at least one meaningful token to appear.
  // (This is intentionally strict-ish; you can tune later.)
  return tokens.some((t) => cand.includes(t));
}

function getPinecone() {
  if (!_pinecone) {
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) throw new Error("PINECONE_API_KEY is required");
    _pinecone = new Pinecone({ apiKey });
  }
  return _pinecone;
}

function getIndexName() {
  return process.env.PINECONE_INDEX || "samushao-candidates";
}

function getIndex() {
  const pc = getPinecone();
  return pc.index({ name: getIndexName() });
}

/** Max chars for the "profession/experience" lead block (title and past roles usually appear here). */
const CANDIDATE_LEAD_CHARS = 12000;

/** Max total chars sent to Pinecone per candidate. */
const CANDIDATE_TEXT_CAP = 30000;

/**
 * Build text for embedding so profession/title and work experience are emphasized.
 * CVs usually have title and experience at the top; we label and repeat that block
 * so the vector aligns more with "Sales Manager, 5 years sales" than generic words.
 */
function buildCandidateTextForEmbedding(cvText) {
  const raw = (cvText || "").trim();
  if (!raw) return "";
  const lead = raw.slice(0, CANDIDATE_LEAD_CHARS).trim();
  const tail = raw.slice(CANDIDATE_LEAD_CHARS).trim().slice(0, CANDIDATE_TEXT_CAP - lead.length - 200);
  if (!tail) return lead.slice(0, CANDIDATE_TEXT_CAP);
  return `Candidate profession and work experience: ${lead}\n\nAdditional details: ${tail}`.slice(0, CANDIDATE_TEXT_CAP);
}

/**
 * Upsert a single candidate's CV to Pinecone (embedding computed via Jina).
 * ID = user_id; overwrites if already exists (Phase 2 & 4).
 * Text is structured so job title and past experience are emphasized for matching.
 *
 * @param {string} userId - user_uid (candidate id)
 * @param {string} cvText - Raw text extracted from CV (field_map text=content)
 * @returns {Promise<boolean>} true if upserted, false if skipped (no text)
 */
async function upsertCandidate(userId, cvText) {
  if (!userId) return false;
  const text = buildCandidateTextForEmbedding(cvText);
  if (!text) return false;

  const index = getIndex();
  const [embedding] = await embedWithJina([text], "retrieval.passage");

  await index.upsert({
    records: [
      {
        id: String(userId),
        values: embedding,
        metadata: {
          text,
          user_id: String(userId),
        },
      },
    ],
    namespace: NAMESPACE,
  });
  return true;
}

/**
 * Build a search query string with structured metadata for better matching.
 * Leads with full job description (richest signal), then adds role/experience/location
 * so semantic search aligns with candidates by profession and experience.
 *
 * @param {object} opts - { job_role (or jobName), job_experience, job_type, job_city, jobDescription }
 */
function buildJobSearchText(opts) {
  const role = (opts.job_role || opts.jobName || "").trim();
  const exp = (opts.job_experience || "").trim();
  const type = (opts.job_type || "").trim();
  const city = (opts.job_city || "").trim();
  const desc = (opts.jobDescription || "").trim();

  const parts = [];
  // Lead with full description so embeddings capture real requirements
  if (desc) parts.push(desc);
  if (role) parts.push(`Position: ${role}.`);
  if (exp) parts.push(`Required experience: ${exp}.`);
  if (type) parts.push(`Employment type: ${type}.`);
  if (city) parts.push(`Location: ${city}.`);

  return parts.filter(Boolean).join(" ");
}

/**
 * Get top K candidates for a job (Phase 3).
 * Uses metadata-enriched query, Jina embeddings, and Pinecone vector search.
 *
 * @param {string|object} jobInput - Job description string, or { jobDescription, job_role, job_experience, job_type, job_city, requireRoleMatch }
 * @param {number} topK - Number of candidates to return after filtering (default 100, max 100)
 * @returns {Promise<Array<{ id: string, score: number, metadata?: object }>>}
 */
async function getTopCandidatesForJob(jobInput, topK = 100) {
  const opts = typeof jobInput === "string" ? { jobDescription: jobInput } : jobInput;
  const text = buildJobSearchText(opts);
  if (!text.trim()) return [];

  const index = getIndex();
  const actualTopK = Math.max(1, Math.min(parseInt(topK, 10) || 100, 100));

  // Fetch more candidates for a better pool, then apply strict filters and trim to actualTopK.
  const fetchK = Math.min(actualTopK * 2, 100);

  const [queryEmbedding] = await embedWithJina([text], "retrieval.query");

  const response = await index.query({
    vector: queryEmbedding,
    topK: fetchK,
    includeMetadata: true,
    namespace: NAMESPACE,
  });

  let matches = response?.matches || [];
  if (opts?.requireRoleMatch && opts?.job_role) {
    matches = matches.filter((hit) => candidateHasRoleExperience(hit?.metadata?.text, opts.job_role));
  }

  const limited = matches.slice(0, actualTopK);
  return limited.map((hit) => ({
    id: hit.id,
    score: hit.score ?? 0,
    metadata: hit.metadata || {},
  }));
}

/**
 * Get a specific candidate's match score for a job using vector search.
 * Uses the job description to query the candidates index; returns the user's score if found.
 *
 * @param {object} job - Job record: jobName, jobDescription, job_experience, job_type, job_city
 * @param {string} userId - user_uid (candidate id)
 * @returns {Promise<number|null>} Similarity score (0-1) or null if user not in index / not in results
 */
async function getCandidateScoreForJob(job, userId) {
  const match = await getCandidateMatchForJob(job, userId);
  return match ? match.score : null;
}

/**
 * Get candidate's match score and CV text for a job (for Gemini assessment).
 * Returns score + cvText from Pinecone metadata; cvText is needed for final Gemini verdict.
 *
 * @param {object} job - Job record: jobName, jobDescription, job_experience, job_type, job_city
 * @param {string} userId - user_uid (candidate id)
 * @returns {Promise<{ score: number, cvText: string }|null>} Match with cvText, or null if user not found
 */
async function getCandidateMatchForJob(job, userId) {
  const opts = {
    job_role: job.jobName || job.job_role,
    job_experience: job.job_experience,
    job_type: job.job_type,
    job_city: job.job_city,
    jobDescription: job.jobDescription || job.job_description,
  };
  const matches = await getTopCandidatesForJob(opts, 100);
  const hit = matches.find((m) => m.id === String(userId));
  if (!hit) return null;
  const cvText = (hit.metadata?.text || "").trim();
  return {
    score: hit.score ?? 0,
    cvText: cvText || "",
  };
}

/**
 * Full flow: extract CV text from URL, upsert to Pinecone.
 * Use for Phase 2 (new signup) and Phase 4 (CV update).
 *
 * @param {string} userId - user_uid
 * @param {string} fileUrl - Cloudinary CV URL
 * @param {string} [fileName] - Original file name
 * @returns {Promise<boolean>} true if upserted successfully
 */
async function indexCandidateFromCvUrl(userId, fileUrl, fileName) {
  const text = await extractTextFromCv(fileUrl, fileName);
  if (!text) return false;
  return upsertCandidate(userId, text);
}

module.exports = {
  getIndex,
  getIndexName,
  upsertCandidate,
  getTopCandidatesForJob,
  getCandidateScoreForJob,
  getCandidateMatchForJob,
  indexCandidateFromCvUrl,
  NAMESPACE,
};

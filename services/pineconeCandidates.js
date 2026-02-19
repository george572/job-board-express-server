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

let _pinecone = null;

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
 * Upsert a single candidate's CV to Pinecone (text is embedded by Pinecone).
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
  const ns = index.namespace(NAMESPACE);
  await ns.upsertRecords({
    records: [
      {
        _id: String(userId),
        text: text, // field_map text=content means we send 'text', Pinecone maps to 'content'
        user_id: String(userId),
      },
    ],
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
 * Uses metadata-enriched query, hybrid-ready (multilingual-e5-large), and reranking.
 *
 * @param {string|object} jobInput - Job description string, or { jobDescription, job_role, job_experience, job_type, job_city, requireRoleMatch }
 * @param {number} topK - Number of candidates to return after reranking (default 100, max 100)
 * @returns {Promise<Array<{ id: string, score: number, metadata?: object }>>}
 */
async function getTopCandidatesForJob(jobInput, topK = 100) {
  const opts = typeof jobInput === "string" ? { jobDescription: jobInput } : jobInput;
  const text = buildJobSearchText(opts);
  if (!text.trim()) return [];

  const index = getIndex();
  const ns = index.namespace(NAMESPACE);
  const actualTopK = Math.max(1, Math.min(parseInt(topK, 10) || 100, 100));

  // bge-reranker-v2-m3 max 100 docs; fetch up to that for reranking pool
  const fetchK = Math.min(actualTopK * 2, 100);

  const response = await ns.searchRecords({
    query: {
      topK: fetchK,
      inputs: { text },
    },
    fields: ["text"],
    rerank: {
      model: "bge-reranker-v2-m3",
      rankFields: ["text"],
      topN: actualTopK,
      parameters: { truncate: "END" },
    },
  });

  let hits = response?.result?.hits || [];
  if (opts?.requireRoleMatch && opts?.job_role) {
    hits = hits.filter((hit) => candidateHasRoleExperience(hit?.fields?.text, opts.job_role));
  }

  return hits.map((hit) => ({
    id: hit._id,
    score: hit._score ?? 0,
    metadata: hit.fields || {},
  }));
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
  indexCandidateFromCvUrl,
  NAMESPACE,
};

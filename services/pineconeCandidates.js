/**
 * Pinecone candidate–job matching using Pinecone integrated embeddings.
 *
 * Flow:
 * - Phase 1: Backfill – extract CV text, upsert as text records (Pinecone embeds them)
 * - Phase 2/4: On CV upload/update – extract text, upsert (overwrites by id)
 * - Phase 3: On job post – search by job description text, get top K candidate IDs
 *
 * No OpenAI required. Index must be created with integrated embeddings, e.g.:
 *   pc index create -n samushao-candidates -m cosine -c aws -r us-east-1 --model llama-text-embed-v2 --field_map text=content
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Pinecone } = require("@pinecone-database/pinecone");
const { extractTextFromCv } = require("./cvTextExtractor");

const NAMESPACE = "candidates";

let _pinecone = null;

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

/**
 * Upsert a single candidate's CV to Pinecone (text is embedded by Pinecone).
 * ID = user_id; overwrites if already exists (Phase 2 & 4).
 *
 * @param {string} userId - user_uid (candidate id)
 * @param {string} cvText - Raw text extracted from CV (field_map text=content)
 * @returns {Promise<boolean>} true if upserted, false if skipped (no text)
 */
async function upsertCandidate(userId, cvText) {
  if (!userId) return false;
  const text = (cvText || "").trim().slice(0, 30000); // reasonable cap for CV text
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
 * Get top K candidates for a job description (Phase 3).
 * Query is embedded by Pinecone; returns matching candidate IDs.
 *
 * @param {string} jobDescription - Full job description text
 * @param {number|string} topK - Number of candidates to return (default 5). Use "all" or 0 to get all candidates.
 * @returns {Promise<Array<{ id: string, score: number, metadata?: object }>>}
 */
async function getTopCandidatesForJob(jobDescription, topK = 5) {
  const text = (jobDescription || "").trim();
  if (!text) return [];

  const index = getIndex();
  const ns = index.namespace(NAMESPACE);

  // Handle "all" candidates: get total count from index stats
  let actualTopK = topK;
  if (topK === "all" || topK === 0 || topK === "0") {
    const stats = await index.describeIndexStats();
    const namespaceStats = stats.namespaces?.[NAMESPACE];
    const totalCount = parseInt(namespaceStats?.recordCount || "0", 10);
    actualTopK = Math.max(1, totalCount); // Use total count, or 1 if no records
  } else {
    actualTopK = Math.max(1, Math.min(parseInt(topK, 10) || 10, 10000)); // Max 10k for safety
  }

  const response = await ns.searchRecords({
    query: {
      topK: actualTopK,
      inputs: { text },
    },
  });

  const hits = response?.result?.hits || [];
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

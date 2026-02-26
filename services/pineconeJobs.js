/**
 * Pinecone jobs index for "jobs for user" recommendations.
 *
 * Jobs are stored as vectors so we can: given a user's CV embedding,
 * query similar jobs (inverse of top-candidates).
 *
 * Uses same Jina embeddings (1024 dim) as candidates for compatibility.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Pinecone } = require("@pinecone-database/pinecone");
const { embedWithJina } = require("./jinaEmbeddings");

let _pinecone = null;
let _candidatesIndex = null;

function getPinecone() {
  if (!_pinecone) {
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) throw new Error("PINECONE_API_KEY is required");
    _pinecone = new Pinecone({ apiKey });
  }
  return _pinecone;
}

function getJobsIndexName() {
  return process.env.PINECONE_JOBS_INDEX || "samushao-jobs";
}

function getJobsIndex() {
  const pc = getPinecone();
  return pc.index({ name: getJobsIndexName() });
}

function getCandidatesIndex() {
  if (!_candidatesIndex) {
    const pc = getPinecone();
    const name = process.env.PINECONE_INDEX || "samushao-candidates";
    _candidatesIndex = pc.index({ name });
  }
  return _candidatesIndex;
}

/**
 * Build job text for embedding (mirrors buildJobSearchText in pineconeCandidates).
 */
function buildJobTextForEmbedding(job) {
  const desc = (job.jobDescription || job.job_description || "").trim();
  const role = (job.jobName || job.job_role || "").trim();
  const exp = (job.job_experience || "").trim();
  const type = (job.job_type || "").trim();
  const city = (job.job_city || "").trim();

  const parts = [];
  if (desc) parts.push(desc);
  if (role) parts.push(`Position: ${role}.`);
  if (exp) parts.push(`Required experience: ${exp}.`);
  if (type) parts.push(`Employment type: ${type}.`);
  if (city) parts.push(`Location: ${city}.`);

  const text = parts.filter(Boolean).join(" ");
  return text.trim() || null;
}

/**
 * Upsert a job into Pinecone. Call when a job is created or updated.
 *
 * @param {number} jobId - Job ID
 * @param {object} job - Job fields: jobName, jobDescription, job_experience, job_type, job_city
 * @returns {Promise<boolean>} true if upserted, false if skipped (no text)
 */
async function upsertJob(jobId, job) {
  if (!jobId) return false;
  const text = buildJobTextForEmbedding(job);
  if (!text) return false;

  const [embedding] = await embedWithJina([text], "retrieval.passage");
  const index = getJobsIndex();

  await index.upsert({
    records: [
      {
        id: String(jobId),
        values: embedding,
        metadata: {
          job_id: jobId,
          job_name: job.jobName || job.job_role || "",
          job_city: job.job_city || "",
        },
      },
    ],
  });
  return true;
}

/**
 * Delete a job from Pinecone. Call when a job expires or is deleted.
 *
 * @param {number|string} jobId - Job ID
 */
async function deleteJob(jobId) {
  if (!jobId) return;
  const index = getJobsIndex();
  await index.deleteOne({ id: String(jobId) });
}

/**
 * Delete multiple jobs from Pinecone by ID.
 *
 * @param {number[]|string[]} jobIds - Job IDs
 */
async function deleteJobs(jobIds) {
  if (!jobIds || jobIds.length === 0) return;
  const index = getJobsIndex();
  await index.deleteMany({ ids: jobIds.map((id) => String(id)) });
}

/**
 * Get top jobs for a user (jobs where this user is a great fit).
 * Uses the user's CV embedding from the candidates index to query the jobs index.
 *
 * @param {string} userId - user_uid (candidate id)
 * @param {number} topK - Max jobs to return (default 50, max 50)
 * @param {number} minScore - Minimum similarity score (default 0.4)
 * @returns {Promise<Array<{ id: string, score: number, metadata?: object }>>}
 */
async function getTopJobsForUser(userId, topK = 50, minScore = 0.4) {
  if (!userId) return [];

  const candidatesIndex = getCandidatesIndex();
  const jobsIndex = getJobsIndex();
  const effectiveTopK = Math.max(1, Math.min(parseInt(topK, 10) || 50, 50));
  const effectiveMinScore = Number.isFinite(minScore) ? minScore : 0.4;

  // Fetch user's CV vector from candidates index
  const fetchResult = await candidatesIndex.fetch({
    ids: [String(userId)],
    namespace: "candidates",
  });
  const records = fetchResult?.records || {};
  const userRecord = records[String(userId)];
  if (!userRecord?.values) {
    return [];
  }

  const response = await jobsIndex.query({
    vector: userRecord.values,
    topK: effectiveTopK,
    includeMetadata: true,
  });

  const matches = (response?.matches || []).filter((m) => (m.score ?? 0) >= effectiveMinScore);
  return matches.map((hit) => ({
    id: hit.id,
    score: hit.score ?? 0,
    metadata: hit.metadata || {},
  }));
}

module.exports = {
  getJobsIndex,
  getJobsIndexName,
  upsertJob,
  deleteJob,
  deleteJobs,
  getTopJobsForUser,
  buildJobTextForEmbedding,
};

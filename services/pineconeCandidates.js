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
const { embedWithJina } = require("./jinaEmbeddings");

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

  // Check both the original role AND its synonyms
  const rolesToCheck = [role];
  const norm = normalizeForMatch(role);
  for (const group of SYNONYM_GROUPS) {
    const normGroup = group.map((t) => normalizeForMatch(t));
    if (normGroup.some((t) => norm.includes(t))) {
      rolesToCheck.push(...group);
      break;
    }
  }

  for (const r of rolesToCheck) {
    const { phrase, tokens } = buildRoleTokens(r);
    if (!phrase) return true;
    if (phrase.length >= 6 && cand.includes(phrase)) return true;
    if (tokens.length > 0 && tokens.every((t) => cand.includes(t))) return true;
  }
  return false;
}

/** Basic/entry-level roles that can be done by any profession. Skip strict role match for these. */
const BASIC_ROLE_KEYWORDS = [
  // Hospitality_Food_Service
  "waitress",
  "waiter",
  "ოფიციანტი",
  "hostess",
  "ჰოსტესი",
  "barista",
  "ბარისტა",
  "kitchen helper",
  "მზარეულის დამხმარე",
  // Retail_Sales
  "consultant",
  "კონსულტანტი",
  "sales assistant",
  "გაყიდვების კონსულტანტი",
  "cashier",
  "მოლარე",
  "promoter",
  "პრომოუტერი",
  "merchandiser",
  "მერჩენდაიზერი",
  // Office_Admin
  "administrator",
  "ადმინისტრატორი",
  "receptionist",
  "რეცეპციონისტი",
  "office assistant",
  "ოფისის ასისტენტი",
  "front desk",
  "მისაღების თანამშრომელი",
  "data entry",
  "მონაცემთა ბაზების ოპერატორი",
  // Customer_Support
  "customer service",
  "მომხმარებელთა მხარდაჭერა",
  "call center operator",
  "ქოლ-ცენტრის ოპერატორი",
  "courier",
  "კურიერი",
];
function isBasicRole(role) {
  const r = normalizeForMatch(role);
  if (!r) return false;
  return BASIC_ROLE_KEYWORDS.some((kw) => r.includes(kw));
}

/** Specialist/senior roles we must NOT suggest for basic jobs (e.g. waitress, receptionist). */
const SPECIALIST_OR_SENIOR_KEYWORDS = [
  "accountant",
  "ბუღალტერი",
  "ceo",
  "chief executive",
  "გენერალური დირექტორი",
  "director",
  "დირექტორი",
  "manager",
  "მენეჯერი",
  "sales manager",
  "hr manager",
  "project manager",
  "მარკეტოლოგი",
  "marketing",
  "developer",
  "პროგრამისტი",
  "engineer",
  "ინჟინერი",
  "lawyer",
  "ადვოკატი",
  "architect",
  "არქიტექტორი",
  "doctor",
  "ექიმი",
  "distributor",
  "დისტრიბუტორი",
  "security officer",
  "security guard",
  "სამედიცინო დამხმარე",
  "დაცვის თანამშრომელი",
  "დაცვა",
];
function candidateIsSpecialistOrSenior(candidateText) {
  const cand = normalizeForMatch(candidateText);
  if (!cand) return false;
  return SPECIALIST_OR_SENIOR_KEYWORDS.some((kw) => cand.includes(kw));
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

/**
 * Synonym groups: terms within the same group are treated as equivalent for search.
 * When a job role matches any term in a group, ALL terms in that group are included in the query.
 */
const SYNONYM_GROUPS = [
  ["დიასახლისი", "სანიტარი", "დამლაგებელი", "cleaner", "housekeeper", "sanitary worker"],
];

function expandWithSynonyms(role) {
  const norm = normalizeForMatch(role);
  if (!norm) return "";
  for (const group of SYNONYM_GROUPS) {
    const normGroup = group.map((t) => normalizeForMatch(t));
    if (normGroup.some((t) => norm.includes(t))) {
      const extras = group.filter((t) => !norm.includes(normalizeForMatch(t)));
      if (extras.length > 0) return extras.join(", ");
    }
  }
  return "";
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
 * Build a search query string. Matching priority:
 * 1) Candidate profession/job title match
 * 2) Past work experience match
 * 3) For basic roles (waitress, consultant, admin etc.) – allow any profession
 *
 * @param {object} opts - { job_role (or jobName), job_experience, job_type, job_city, jobDescription }
 */
function buildJobSearchText(opts) {
  const role = (opts.job_role || opts.jobName || "").trim();
  const exp = (opts.job_experience || "").trim();
  const type = (opts.job_type || "").trim();
  const city = (opts.job_city || "").trim();
  const desc = (opts.jobDescription || "").trim();

  const synonyms = role ? expandWithSynonyms(role) : "";
  const roleWithSynonyms = synonyms ? `${role} (ან ${synonyms})` : role;

  const parts = [];
  if (role) {
    parts.push(
      `Seeking candidates whose profession or job title is ${roleWithSynonyms}, or who have worked as ${roleWithSynonyms} or very similar position, or on positions one step above or one step below.`,
    );
  }
  if (role) parts.push(`Relevant past work experience: ${roleWithSynonyms}.`);
  if (desc) parts.push(desc);
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
  const role = opts?.job_role || opts?.jobName;
  const jobIsBasic = role && isBasicRole(role);
  if (jobIsBasic) {
    // For basic roles: only suggest basic candidates. Exclude accountants, CEOs, managers, etc.
    matches = matches.filter(
      (hit) => !candidateIsSpecialistOrSenior(hit?.metadata?.text),
    );
  } else if (opts?.requireRoleMatch && role) {
    // Non-basic roles: require CV to mention the job role
    matches = matches.filter((hit) =>
      candidateHasRoleExperience(hit?.metadata?.text, role),
    );
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
 * Build text for embedding from user-without-cv form data.
 * Structured like candidate text so job descriptions match well (profession, experience, categories).
 */
function buildUserWithoutCvTextForEmbedding(data) {
  const name = (data.name || "").trim();
  const desc = (data.short_description || "").trim();
  const cats = Array.isArray(data.categories)
    ? data.categories.join(", ")
    : (data.categories || "").toString().replace(/,/g, ", ").trim();
  const other = (data.other_specify || "").trim();
  const parts = [];
  if (desc) parts.push(`Candidate profession and work experience: ${desc}`);
  if (cats) parts.push(`Interested in positions: ${cats}`);
  if (name) parts.push(`Name: ${name}`);
  if (other) parts.push(`Other: ${other}`);
  return parts.length ? parts.join(". ") : (name ? `Candidate: ${name}` : "");
}

/**
 * Upsert a user-without-cv form submission to Pinecone for semantic job matching.
 * Uses same index as candidates, namespace "user_without_cv".
 *
 * @param {number} id - user_without_cv row id
 * @param {object} data - { name, email, phone, short_description, categories, other_specify }
 * @returns {Promise<boolean>} true if upserted, false if skipped (no text)
 */
async function upsertUserWithoutCv(id, data) {
  if (!id || !data) return false;
  const text = buildUserWithoutCvTextForEmbedding(data);
  if (!text) return false;

  const index = getIndex();
  const [embedding] = await embedWithJina([text], "retrieval.passage");

  const categoriesStr =
    Array.isArray(data.categories) ? data.categories.join(",") : String(data.categories || "");
  const meta = {
    text,
    user_without_cv_id: id,
    name: (data.name || "").toString().slice(0, 255),
    phone: (data.phone || "").toString().slice(0, 50),
  };
  const emailVal = (data.email || "").toString().trim().slice(0, 255);
  if (emailVal) meta.email = emailVal;
  const descVal = (data.short_description || "").toString().trim().slice(0, 1000);
  if (descVal) meta.short_description = descVal;
  if (categoriesStr) meta.categories = categoriesStr;
  const otherVal = (data.other_specify || "").toString().trim().slice(0, 255);
  if (otherVal) meta.other_specify = otherVal;

  await index.upsert({
    records: [{ id: `no_cv_${id}`, values: embedding, metadata: meta }],
    namespace: NAMESPACE,
  });
  return true;
}

/**
 * Delete a candidate's vector from Pinecone. Call when CV is deleted.
 *
 * @param {string} userId - user_uid
 * @returns {Promise<void>}
 */
async function deleteCandidate(userId) {
  if (!userId) return;
  const index = getIndex();
  await index.deleteOne({ id: String(userId), namespace: NAMESPACE });
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
  deleteCandidate,
  upsertUserWithoutCv,
  getTopCandidatesForJob,
  getCandidateScoreForJob,
  getCandidateMatchForJob,
  indexCandidateFromCvUrl,
  NAMESPACE,
};

# Admin: Request matching candidates for a job

Use this in the admin app (e.g. samushao-admin) so that when you click **"Request candidates"** (or similar) for a job post, it loads the top matching candidates from Pinecone.

## API

**GET** `/jobs/:id/top-candidates?topK=100&minScore=0.4&requireRoleMatch=0`

- **`:id`** — Job ID (integer).
- **`topK`** (optional) — Number of candidates to request from Pinecone (default `100`, max `100`).
  - We request this many from Pinecone, then filter by minScore. You get back only those that pass (0 to topK).
- **`minScore`** (optional) — Minimum relevance score threshold (default `0.5`). Admin-controlled; only candidates with `score >= minScore` are returned.
  - Only candidates with `score >= minScore` are returned.
  - **Score calibration for CV–job matching:** Reranker scores rarely reach 0.9; 0.4–0.7 = decent match, 0.7+ = strong. Use `minScore=0` to include all requested candidates.
- **`requireRoleMatch`** (optional) — If `1` / `true`, filters out candidates whose CV text does **not** explicitly mention the job title (or at least one meaningful word from it).
  - Use this to remove “semantically kinda related” but clearly irrelevant CVs.
  - Example: for `jobName = "Sales Manager"`, CV must contain “sales manager” or at least “sales” / “manager”.

**Response:**

```json
{
  "job_id": 123,
  "candidates": [
    {
      "user_id": "101029172809291256684",
      "score": 0.87,
      "user_name": "John Doe",
      "user_email": "john@example.com",
      "cv_url": "https://res.cloudinary.com/.../attachment/..."
    }
  ]
}
```

- **`score`** — Match score (0–1, higher = better fit). Only candidates with `score >= minScore` (default 0.4) are returned.
- **`cv_url`** — Direct link to download the CV (Cloudinary).
- **`gemini_assessment`** (when `assessWithGemini=1`) — `{ fit_score: 0-100, summary: string, verdict: "STRONG_MATCH"|"GOOD_MATCH"|"PARTIAL_MATCH"|"WEAK_MATCH" }` or `{ error: string }` on failure.

**Examples:**

```bash
# Get up to 100 qualified candidates (score >= 0.4) — default
GET /jobs/123/top-candidates

# Request 50, get back only those with score >= 0.4
GET /jobs/123/top-candidates?topK=50

# Stricter threshold (score >= 0.7)
GET /jobs/123/top-candidates?topK=100&minScore=0.7

# Enforce title/role mention in CV text (stricter, fewer but cleaner results)
GET /jobs/123/top-candidates?topK=100&minScore=0.4&requireRoleMatch=1

# No score filter (all 100 returned)
GET /jobs/123/top-candidates?topK=100&minScore=0
```

## How It Works

1. **Pinecone query**: We request up to `topK` candidates (default 100, max 100), sorted by score (highest first).
2. **Filter**: We keep only candidates with `score >= minScore` (default 0.4).
3. **Response**: You get back only those that pass the threshold (0 to 100). No large payloads.

## How the request is sent to Pinecone

**Model:** multilingual-e5-large (multilingual, good for Georgian + English CVs)

**Search type:** This is **semantic search over text records** (Pinecone generates dense embeddings for CVs + query using `multilingual-e5-large`), with **integrated reranking** (`bge-reranker-v2-m3`). It is not hybrid (dense+sparse) search.

**Metadata-enriched query:**

- The search text includes structured fields: `job_role`, `job_experience`, `job_type`, `job_city`
- Example: `job_role: Sales Manager. Required experience: 3 years. Role: Sales Manager. job_type: full-time. job_city: Tbilisi. [job description]`
- This helps match by profession and experience, not generic words (e.g. "Sales Manager" vs "HR Manager")

**Candidate side (indexed CVs):**

- CV text is structured: `Candidate profession and work experience: [first ~12k chars] … Additional details: [rest]`
- So the vector aligns with the candidate's actual title and past roles.

**Reranking:**

- We fetch 2× topK candidates, then rerank with **bge-reranker-v2-m3** and return topK.
- Reranking improves quality by scoring query–document relevance more accurately.

**Flow:**

1. Backend builds job query with metadata (`job_role`, `job_experience`, etc.), calls Pinecone `searchRecords` with `inputs: { text }`, `fields: ['text']`, and `rerank: { model: 'bge-reranker-v2-m3', rankFields: ['text'], topN }`.
2. Pinecone embeds the query (multilingual-e5-large), runs similarity search, reranks, returns top N.
3. Backend filters by `minScore` and enriches with user/resume from the DB.

## CORS

The server allows the admin origin (e.g. `https://samushao-admin.web.app`). If you use a different admin URL, add it to the CORS config in `server.js`.

## Example: button + fetch (admin UI)

Add a **"Request candidates"** (or "Matching candidates") control next to each job in the admin list/detail. On click, call the API and show the list.

**Minimal fetch example:**

```javascript
async function loadMatchingCandidates(jobId, topK = 100, minScore = 0.4) {
  const base = "https://your-api.samushao.ge"; // or process.env.REACT_APP_API_URL
  const res = await fetch(`${base}/jobs/${jobId}/top-candidates?topK=${topK}&minScore=${minScore}`);
  if (!res.ok) throw new Error("Failed to load candidates");
  const data = await res.json();
  return data.candidates; // array of { user_id, score, user_name, user_email, cv_url } (only those with score >= minScore)
}
```

**React-style usage:**

```jsx
// In your job row or job detail component
const [candidates, setCandidates] = useState([]);
const [loading, setLoading] = useState(false);

async function handleRequestCandidates(jobId, topK = 100, minScore = 0.4) {
  setLoading(true);
  try {
    const res = await fetch(`${API_BASE}/jobs/${jobId}/top-candidates?topK=${topK}&minScore=${minScore}`);
    const data = await res.json();
    setCandidates(data.candidates || []); // Only candidates with score >= minScore
  } catch (e) {
    console.error(e);
  } finally {
    setLoading(false);
  }
}

// Button
<button onClick={() => handleRequestCandidates(job.id)} disabled={loading}>
  {loading ? "Loading…" : "Request candidates"}
</button>

// List
{candidates.map((c) => (
  <div key={c.user_id}>
    <span>{c.user_name}</span> — {c.user_email}
    <span>Score: {(c.score * 100).toFixed(0)}%</span>
    {c.cv_url && <a href={c.cv_url} target="_blank" rel="noopener">CV</a>}
  </div>
))}
```

## Backend

- Route: `routes/jobs.js` — `GET /:id/top-candidates`
- Service: `services/pineconeCandidates.js` — `getTopCandidatesForJob(description, topK)`

No auth is enforced on this endpoint in the backend; add auth in the admin app or via a gateway if needed.

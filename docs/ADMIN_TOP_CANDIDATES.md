# Admin: Request matching candidates for a job

Use this in the admin app (e.g. samushao-admin) so that when you click **"Request candidates"** (or similar) for a job post, it loads the top matching candidates from Pinecone.

## API

**GET** `/jobs/:id/top-candidates?topK=100&minScore=0.7`

- **`:id`** — Job ID (integer).
- **`topK`** (optional) — Number of candidates to request from Pinecone (default `100`, max `100`).
  - We request this many from Pinecone, then filter by minScore. You get back only those that pass (0 to topK).
- **`minScore`** (optional) — Minimum relevance score threshold (default `0.7`).
  - Only candidates with `score >= minScore` are returned.
  - Use `minScore=0` to include all requested candidates regardless of score.

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

- **`score`** — Match score (0–1, higher = better fit). Only candidates with `score >= minScore` (default 0.7) are returned.
- **`cv_url`** — Direct link to download the CV (Cloudinary).

**Examples:**

```bash
# Get up to 100 qualified candidates (score >= 0.7) — default
GET /jobs/123/top-candidates

# Request 50, get back only those with score >= 0.7
GET /jobs/123/top-candidates?topK=50

# Lower threshold (score >= 0.5)
GET /jobs/123/top-candidates?topK=100&minScore=0.5

# No score filter (all 100 returned)
GET /jobs/123/top-candidates?topK=100&minScore=0
```

## How It Works

1. **Pinecone query**: We request up to `topK` candidates (default 100, max 100), sorted by score (highest first).
2. **Filter**: We keep only candidates with `score >= minScore` (default 0.7).
3. **Response**: You get back only those that pass the threshold (0 to 100). No large payloads.

## How the request is sent to Pinecone (title & experience emphasis)

We want matches by **job title and experience**, not by generic words (e.g. "Sales Manager" should not match "HR Manager" just because of "manager").

**Job side (query):**

- The text we send to Pinecone is built to emphasize **job title** and **required experience**:
  - `Job title: Sales Manager. Required experience: 3 years. Role: Sales Manager. [rest of job description]`
- Pinecone embeds this text and runs a vector similarity search. Leading with "Job title: … Required experience: … Role: …" makes the embedding focus on the actual role and experience level.

**Candidate side (indexed CVs):**

- When we index a CV, we structure the text so **profession and work experience** are emphasized:
  - We take the first ~12,000 characters of the CV (where title and experience usually appear) and label them:  
    `Candidate profession and work experience: [first part of CV] … Additional details: [rest]`
- So the candidate vector aligns more with their actual title and past roles than with every word in the CV.

**Flow:**

1. Backend builds the job query string (title + experience first), then calls Pinecone `searchRecords({ query: { topK, inputs: { text: description } } })`.
2. Pinecone embeds the job text with the same model used for the index (e.g. llama-text-embed-v2), returns top K by similarity.
3. Backend filters by `minScore` and enriches with user/resume data from the DB.

## CORS

The server allows the admin origin (e.g. `https://samushao-admin.web.app`). If you use a different admin URL, add it to the CORS config in `server.js`.

## Example: button + fetch (admin UI)

Add a **"Request candidates"** (or "Matching candidates") control next to each job in the admin list/detail. On click, call the API and show the list.

**Minimal fetch example:**

```javascript
async function loadMatchingCandidates(jobId, topK = 100, minScore = 0.7) {
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

async function handleRequestCandidates(jobId, topK = 100, minScore = 0.7) {
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

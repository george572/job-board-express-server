# Admin: Request matching candidates for a job

Use this in the admin app (e.g. samushao-admin) so that when you click **"Request candidates"** (or similar) for a job post, it loads the top matching candidates from Pinecone.

## API

**GET** `/jobs/:id/top-candidates?topK=N`

- **`:id`** — Job ID (integer).
- **`topK`** (optional) — Number of candidates to return.
  - Default: `10` if omitted.
  - Use `topK=all` or `topK=0` to get **all matching candidates** (fetches total count from Pinecone).
  - Max: `10000` if a number is provided.

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

- **`score`** — Match score (0–1, higher = better fit).
- **`cv_url`** — Direct link to download the CV (Cloudinary).

## CORS

The server allows the admin origin (e.g. `https://samushao-admin.web.app`). If you use a different admin URL, add it to the CORS config in `server.js`.

## Example: button + fetch (admin UI)

Add a **"Request candidates"** (or "Matching candidates") control next to each job in the admin list/detail. On click, call the API and show the list.

**Minimal fetch example:**

```javascript
async function loadMatchingCandidates(jobId, topK = "all") {
  const base = "https://your-api.samushao.ge"; // or process.env.REACT_APP_API_URL
  const url = topK === "all" 
    ? `${base}/jobs/${jobId}/top-candidates?topK=all` // use topK=all to get all
    : `${base}/jobs/${jobId}/top-candidates?topK=${topK}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load candidates");
  const data = await res.json();
  return data.candidates; // array of { user_id, score, user_name, user_email, cv_url }
}
```

**React-style usage:**

```jsx
// In your job row or job detail component
const [candidates, setCandidates] = useState([]);
const [loading, setLoading] = useState(false);

async function handleRequestCandidates(jobId, getAll = false) {
  setLoading(true);
  try {
    const url = getAll 
      ? `${API_BASE}/jobs/${jobId}/top-candidates?topK=all` // use topK=all to get all
      : `${API_BASE}/jobs/${jobId}/top-candidates?topK=20`;
    const res = await fetch(url);
    const data = await res.json();
    setCandidates(data.candidates || []);
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

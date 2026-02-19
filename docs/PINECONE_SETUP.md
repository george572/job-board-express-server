# Pinecone Candidate–Job Matching Setup

## Overview

This system uses **Pinecone integrated embeddings** (no OpenAI): CV text is sent to Pinecone, which embeds and indexes it. When a job is posted, you query by job description text and get the top matching candidates.

## 1. Create Pinecone Index

Create an index **with integrated embeddings** (Pinecone embeds the text for you):

```bash
# If not installed: brew tap pinecone-io/tap && brew install pinecone-io/tap/pinecone
# If PINECONE_API_KEY is already in .env, load it first:
source .env
export PINECONE_API_KEY   # CLI reads from env

pc index create -n samushao-candidates -m cosine -c aws -r us-east-1 --model llama-text-embed-v2 --field_map text=content
```

Get your API key from [https://app.pinecone.io/](https://app.pinecone.io/) (only needed if not already in `.env`).

## 2. Environment Variables

Add to `.env`:

```
PINECONE_API_KEY=your-pinecone-api-key
PINECONE_INDEX=samushao-candidates
```

No OpenAI (or other embedding) API key is required.

## 3. Phase 1 — One-time Backfill

Run the backfill script once to index all existing candidates:

```bash
npm run backfill-pinecone
```

This will:

- Fetch all candidates with resumes from the DB
- Extract text from each CV (PDF/DOC/DOCX)
- Upsert text to Pinecone (Pinecone generates embeddings; id = user_uid)

## 4. Phase 2 & 4 — New CV Upload / Update

Already wired: when a user uploads or updates their CV via `POST /resumes`, the new CV is automatically indexed in Pinecone. Same ID = overwrite.

## 5. Phase 3 — Get Top Candidates for a Job

**Endpoint:** `GET /jobs/:id/top-candidates?topK=N` (default topK=10, max 10000, or use `topK=all` to get all candidates)

Returns the top matching candidates for a job based on semantic similarity between job description and CVs.

Example:

```bash
curl "http://localhost:3000/jobs/123/top-candidates?topK=20"
```

**Admin UI:** See [ADMIN_TOP_CANDIDATES.md](./ADMIN_TOP_CANDIDATES.md) for how to add a "Request candidates" button in the admin app.

Response:

```json
{
  "job_id": 123,
  "candidates": [
    {
      "user_id": "abc-uid-123",
      "score": 0.89,
      "user_name": "John Doe",
      "user_email": "john@example.com",
      "cv_url": "https://..."
    }
  ]
}
```

---

## Failed candidates and retry

After a backfill run, failed candidates are written to **`scripts/backfill-pinecone-failed.json`** with `user_id`, `file_url`, `file_name`, and **`error`** (the real reason, e.g. corrupt docx, no body element, zip error).

**Re-run only failed:**

```bash
npm run backfill-pinecone:retry
```

**If you ran the backfill before this feature** and don’t have the JSON file, build it from a list of failed `user_id`s (one per line):

```bash
# Paste the 53 user_ids into failed-ids.txt, then:
node scripts/backfill-pinecone-build-failed-list.js < failed-ids.txt
npm run backfill-pinecone:retry
```

**Typical failure reasons:**

- **"Can't find end of central directory"** — Corrupt or incomplete .docx (docx is a zip); re-upload or use PDF.
- **"Could not find the body element: are you sure this is a docx file?"** — Old .doc (Word 97) or malformed docx; mammoth only supports .docx. Re-save as .docx or upload PDF.
- **"no text extracted (text too short or empty)"** — PDF/DOCX parse returned little or no text (e.g. image-only PDF, empty file).

---

## Troubleshooting

- **"PINECONE_API_KEY required"** — Add to `.env`
- **Index not found / wrong index type** — Create the index with **integrated embeddings** (the `pc index create ... --model llama-text-embed-v2 --field_map text=content` command above). Do not use a dimension-only (serverless) index.
- **No text extracted from CV** — Check that CVs are PDF or DOC/DOCX; some formats may fail
- **Rate limits** — Backfill uses batching and delays; reduce `BATCH_SIZE` if needed

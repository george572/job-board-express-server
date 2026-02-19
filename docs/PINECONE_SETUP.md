# Pinecone Candidate–Job Matching Setup

## Overview

This system uses **Jina `jina-embeddings-v3`** for embeddings and a **Pinecone vector index (1024-dim, cosine)** for candidate–job matching. CV text is embedded via Jina, stored as vectors in Pinecone, and searches use metadata-enriched queries (job_role, job_experience, etc.) embedded via Jina as well.

## 1. Create Pinecone Index

Create a **vector index** (dim 1024, cosine) for Jina embeddings:

```bash
npm run create-pinecone-index
```

Or manually:

```bash
node scripts/create-pinecone-index-e5.js
```

**If you have an existing index** (e.g. with llama-text-embed-v2), you must either:
- Delete it first and create the new one with the same name, or
- Create the new index with a different name and set `PINECONE_INDEX` in `.env`

The script creates an index with:
- Dimension: `1024`
- Metric: `cosine`
- Serverless: `aws`, region `us-east-1`

## 2. Environment Variables

Add to `.env`:

```
PINECONE_API_KEY=your-pinecone-api-key
PINECONE_INDEX=samushao-candidates
JINA_API_KEY=your-jina-api-key
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
- Structure text to emphasize profession and experience
- Call Jina to embed the CV text (`task: retrieval.passage`)
- Upsert embeddings to Pinecone as vectors (`values`) with metadata (including the CV text); id = user_uid

## 4. Phase 2 & 4 — New CV Upload / Update

Already wired: when a user uploads or updates their CV via `POST /resumes`, the new CV is automatically indexed in Pinecone. Same ID = overwrite.

## 5. Phase 3 — Get Top Candidates for a Job

**Endpoint:** `GET /jobs/:id/top-candidates?topK=100&minScore=0.5`

Returns the top matching candidates using:
- **Metadata-enriched query**: job_role, job_experience, job_type, job_city in the search text
- **Jina embeddings for queries** (`task: retrieval.query`) and **Pinecone vector search**

**Admin UI:** See [ADMIN_TOP_CANDIDATES.md](./ADMIN_TOP_CANDIDATES.md).

---

## Hybrid Search (Advanced)

Hybrid search (semantic + lexical) combines dense (multilingual-e5-large) and sparse (pinecone-sparse-english-v0) vectors. It requires:

- A **hybrid index** (dense, metric dotproduct, dimension 1024)
- Manual embedding at upsert and query via `pc.inference.embed`
- Standalone reranking after the hybrid query

The current implementation uses the **integrated index** (multilingual-e5 + reranking), which is simpler and supports integrated reranking. To migrate to hybrid search, you would:

1. Create a hybrid index (dense + sparse support)
2. Use `pc.inference.embed` for both dense and sparse models
3. Upsert with `values` + `sparse_values`
4. Query with both vectors
5. Call `pc.inference.rerank` as a separate step

See [Pinecone hybrid search docs](https://docs.pinecone.io/guides/data/encode-sparse-vectors) for details.

---

## Failed candidates and retry

After a backfill run, failed candidates are written to **`scripts/backfill-pinecone-failed.json`** with `user_id`, `file_url`, `file_name`, and **`error`**.

**Re-run only failed:**

```bash
npm run backfill-pinecone:retry
```

**Typical failure reasons:**

- **"Can't find end of central directory"** — Corrupt or incomplete .docx
- **"Could not find the body element"** — Old .doc (Word 97); use .docx or PDF
- **"no text extracted"** — Image-only PDF, empty file

---

## Troubleshooting

- **"PINECONE_API_KEY required"** — Add to `.env`
- **Index not found** — Run `npm run create-pinecone-index`
- **Wrong model / embeddings** — Delete the index and recreate with the e5 script
- **No text extracted from CV** — Check that CVs are PDF or DOC/DOCX
- **Rate limits** — Backfill uses batching and delays; reduce `BATCH_SIZE` if needed

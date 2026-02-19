#!/usr/bin/env node
/**
 * Phase 1: One-time backfill of all candidates to Pinecone.
 *
 * 1. Pull all candidates (users with resumes) from DB
 * 2. For each: fetch CV, extract text, upsert to Pinecone (integrated embeddings)
 *
 * Usage:
 *   node scripts/backfill-pinecone-candidates.js              # full backfill
 *   node scripts/backfill-pinecone-candidates.js --retry-failed   # re-run only failed from last run
 *
 * Failed candidates are written to scripts/backfill-pinecone-failed.json with reasons.
 *
 * Prerequisites:
 * - .env: PINECONE_API_KEY
 * - Pinecone index with integrated embeddings: pc index create -n samushao-candidates -m cosine -c aws -r us-east-1 --model llama-text-embed-v2 --field_map text=content
 */
const path = require("path");
const fs = require("fs");

// Load .env from project root (works when run as npm script or directly)
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
} else {
  require("dotenv").config({ path: path.join(process.cwd(), ".env") });
}

const knex = require("knex");
const knexfile = require("../knexfile");
const { indexCandidateFromCvUrl } = require("../services/pineconeCandidates");

const env = process.env.NODE_ENV || "development";
const db = knex(knexfile[env]);

const BATCH_SIZE = 10; // Process N at a time to avoid rate limits
const DELAY_MS = 500;   // Between batches
const FAILED_FILE = path.join(__dirname, "backfill-pinecone-failed.json");

async function getAllCandidatesWithLatestResume() {
  const rows = await db.raw(`
    SELECT DISTINCT ON (r.user_id)
      r.user_id,
      r.file_url,
      r.file_name
    FROM resumes r
    ORDER BY r.user_id, r.updated_at DESC NULLS LAST, r.id DESC
  `);
  return rows.rows || rows;
}

function getErrorReason(result) {
  if (result.status === "rejected") {
    return result.reason?.message || String(result.reason);
  }
  return "no text extracted";
}

async function main() {
  const retryFailed = process.argv.includes("--retry-failed");

  console.log("Phase 1: Backfilling candidates to Pinecone...\n");

  const apiKey = (process.env.PINECONE_API_KEY || "").trim();
  if (!apiKey) {
    console.error("Missing PINECONE_API_KEY in .env. Add it to your project root .env and run again.");
    process.exit(1);
  }

  let candidates;
  if (retryFailed) {
    if (!fs.existsSync(FAILED_FILE)) {
      console.error("No failed list found. Run a full backfill first; failed candidates will be written to:", FAILED_FILE);
      process.exit(1);
    }
    candidates = JSON.parse(fs.readFileSync(FAILED_FILE, "utf8"));
    console.log(`Retrying ${candidates.length} previously failed candidates.\n`);
  } else {
    candidates = await getAllCandidatesWithLatestResume();
    console.log(`Found ${candidates.length} candidates with resumes.\n`);
  }

  const failedList = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((c) => indexCandidateFromCvUrl(c.user_id, c.file_url, c.file_name))
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const c = batch[j];
      const user_id = c.user_id;
      const file_url = c.file_url || "";
      const file_name = c.file_name || "";

      if (r.status === "fulfilled" && r.value) {
        console.log(`  ✓ ${user_id}`);
      } else {
        const err = getErrorReason(r);
        failedList.push({ user_id, file_url, file_name, error: err });
        console.log(`  ✗ ${user_id} — ${err}`);
      }
    }

    if (i + BATCH_SIZE < candidates.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  const ok = candidates.length - failedList.length;
  const fail = failedList.length;

  if (failedList.length > 0) {
    fs.writeFileSync(FAILED_FILE, JSON.stringify(failedList, null, 2), "utf8");
    console.log(`\nDone. Success: ${ok}, Failed: ${fail}`);
    console.log(`Failed list written to: ${FAILED_FILE}`);
    console.log("Re-run only failed: npm run backfill-pinecone -- --retry-failed");
  } else {
    console.log(`\nDone. Success: ${ok}, Failed: 0`);
    if (fs.existsSync(FAILED_FILE)) fs.unlinkSync(FAILED_FILE);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

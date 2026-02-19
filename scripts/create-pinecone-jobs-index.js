#!/usr/bin/env node
/**
 * Create Pinecone vector index for job–candidate matching (jobs as vectors).
 * Used to find jobs where a user is a great fit (inverse of top-candidates).
 *
 * Run once to create the index, then set PINECONE_JOBS_INDEX in .env and run backfill.
 *
 * Usage: node scripts/create-pinecone-jobs-index.js
 *
 * Requires: PINECONE_API_KEY in .env
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Pinecone } = require("@pinecone-database/pinecone");

const INDEX_NAME = process.env.PINECONE_JOBS_INDEX || "samushao-jobs";

async function main() {
  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) {
    console.error("Missing PINECONE_API_KEY in .env");
    process.exit(1);
  }

  const pc = new Pinecone({ apiKey });

  console.log(`Creating vector index "${INDEX_NAME}" for jobs (Jina dim=1024, metric=cosine)...`);

  try {
    await pc.createIndex({
      name: INDEX_NAME,
      dimension: 1024,
      metric: "cosine",
      spec: {
        serverless: {
          cloud: "aws",
          region: "us-east-1",
        },
      },
      waitUntilReady: true,
      suppressConflicts: true,
    });
    console.log(`Index "${INDEX_NAME}" is ready.`);
  } catch (err) {
    console.error("Failed to create index:", err.message);
    process.exit(1);
  }
}

main();

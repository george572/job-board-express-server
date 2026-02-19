#!/usr/bin/env node
/**
 * One-time backfill of all active (non-expired) jobs to Pinecone jobs index.
 *
 * Usage: node scripts/backfill-pinecone-jobs.js
 *
 * Prerequisites:
 * - .env: PINECONE_API_KEY, JINA_API_KEY, PINECONE_JOBS_INDEX
 * - Jobs index created: npm run create-pinecone-jobs-index
 */
const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
} else {
  require("dotenv").config({ path: path.join(process.cwd(), ".env") });
}

const knex = require("knex");
const knexfile = require("../knexfile");
const { upsertJob } = require("../services/pineconeJobs");

const env = process.env.NODE_ENV || "development";
const db = knex(knexfile[env]);

const BATCH_SIZE = 1;
const DELAY_MS = 4500; // 4.5s between requests to avoid Jina rate limiting

async function getActiveJobs() {
  const rows = await db("jobs")
    .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
    .select("id", "jobName", "jobDescription", "job_experience", "job_type", "job_city");
  return rows;
}

async function main() {
  console.log("Backfilling jobs to Pinecone jobs index...\n");

  const apiKey = (process.env.PINECONE_API_KEY || "").trim();
  if (!apiKey) {
    console.error("Missing PINECONE_API_KEY in .env");
    process.exit(1);
  }
  const jinaKey = (process.env.JINA_API_KEY || "").trim();
  if (!jinaKey) {
    console.error("Missing JINA_API_KEY in .env");
    process.exit(1);
  }

  const jobs = await getActiveJobs();
  console.log(`Found ${jobs.length} active (non-expired) jobs.\n`);

  let ok = 0;
  let skipped = 0; // no text to embed
  let errored = 0;
  const errorSamples = [];

  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((job) =>
        upsertJob(job.id, {
          jobName: job.jobName,
          jobDescription: job.jobDescription,
          job_experience: job.job_experience,
          job_type: job.job_type,
          job_city: job.job_city,
        })
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) ok++;
      else if (r.status === "fulfilled" && !r.value) skipped++;
      else {
        errored++;
        const err = r.reason?.message || String(r.reason);
        if (errorSamples.length < 5 && !errorSamples.includes(err)) errorSamples.push(err);
      }
    }
    const done = Math.min(i + BATCH_SIZE, jobs.length);
    process.stdout.write(`\rIndexed ${done}/${jobs.length} (ok: ${ok}, skipped: ${skipped}, errors: ${errored})`);
    if (i + BATCH_SIZE < jobs.length) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }
  console.log();

  console.log(`\nDone. Indexed: ${ok}, skipped (no text): ${skipped}, errors: ${errored}`);
  if (errorSamples.length > 0) {
    console.log("\nSample errors:");
    errorSamples.forEach((e) => console.log("  -", e));
  }
  process.exit(errored > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

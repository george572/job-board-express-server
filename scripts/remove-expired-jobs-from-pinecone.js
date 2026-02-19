#!/usr/bin/env node
/**
 * Remove expired jobs from Pinecone jobs index.
 * Run periodically (e.g. cron) to keep the index in sync.
 *
 * Usage: node scripts/remove-expired-jobs-from-pinecone.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const knexfile = require("../knexfile");
const { deleteJobs } = require("../services/pineconeJobs");

const env = process.env.NODE_ENV || "development";
const db = knex(knexfile[env]);

async function getExpiredJobIds() {
  const rows = await db("jobs")
    .whereNotNull("expires_at")
    .where("expires_at", "<", db.fn.now())
    .select("id");
  return rows.map((r) => r.id);
}

async function main() {
  const apiKey = (process.env.PINECONE_API_KEY || "").trim();
  if (!apiKey) {
    console.error("Missing PINECONE_API_KEY in .env");
    process.exit(1);
  }

  const ids = await getExpiredJobIds();
  if (ids.length === 0) {
    console.log("No expired jobs to remove.");
    return;
  }

  await deleteJobs(ids);
  console.log(`Removed ${ids.length} expired job(s) from Pinecone.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

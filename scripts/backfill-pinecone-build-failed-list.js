#!/usr/bin/env node
/**
 * Build backfill-pinecone-failed.json from a list of user_ids (e.g. the 53 that failed).
 * Then run: npm run backfill-pinecone -- --retry-failed
 *
 * Usage:
 *   node scripts/backfill-pinecone-build-failed-list.js < failed-ids.txt
 *   echo "101029172809291256684" | node scripts/backfill-pinecone-build-failed-list.js
 *
 * failed-ids.txt = one user_id per line (paste from terminal output of failed runs).
 */
const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const knex = require("knex");
const knexfile = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexfile[env]);

const FAILED_FILE = path.join(__dirname, "backfill-pinecone-failed.json");

async function main() {
  const stdin = process.stdin.isTTY ? "" : await readStdin();
  const lines = stdin
    .split(/\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  if (lines.length === 0) {
    console.error("Usage: paste user_ids (one per line) and pipe to this script, or pass a file.");
    console.error("Example: node scripts/backfill-pinecone-build-failed-list.js < failed-ids.txt");
    process.exit(1);
  }

  const userIds = [...new Set(lines)];
  const rows = await db("resumes")
    .whereIn("user_id", userIds)
    .orderBy("updated_at", "desc")
    .orderBy("id", "desc")
    .select("user_id", "file_url", "file_name");
  const byUser = {};
  for (const r of rows) {
    if (!byUser[r.user_id]) byUser[r.user_id] = r;
  }

  const failedList = userIds.map((user_id) => {
    const row = byUser[user_id];
    return {
      user_id,
      file_url: row?.file_url || "",
      file_name: row?.file_name || "",
      error: "pending retry",
    };
  });

  fs.writeFileSync(FAILED_FILE, JSON.stringify(failedList, null, 2), "utf8");
  console.log(`Wrote ${failedList.length} entries to ${FAILED_FILE}`);
  console.log("Run: npm run backfill-pinecone -- --retry-failed");
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(chunks.join("")));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

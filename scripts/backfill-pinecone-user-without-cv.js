#!/usr/bin/env node
/**
 * One-time backfill of user_without_cv rows to Pinecone (candidates namespace).
 *
 * Usage:
 *   node scripts/backfill-pinecone-user-without-cv.js
 *
 * Prerequisites:
 * - .env: PINECONE_API_KEY, JINA_API_KEY
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
const { upsertUserWithoutCv } = require("../services/pineconeCandidates");

const env = process.env.NODE_ENV || "development";
const db = knex(knexfile[env]);

async function main() {
  console.log("Backfilling user_without_cv to Pinecone (candidates namespace)...\n");

  if (!(process.env.PINECONE_API_KEY || "").trim()) {
    console.error("Missing PINECONE_API_KEY in .env");
    process.exit(1);
  }
  if (!(process.env.JINA_API_KEY || "").trim()) {
    console.error("Missing JINA_API_KEY in .env");
    process.exit(1);
  }

  const rows = await db("user_without_cv").select("*").orderBy("id", "asc");
  console.log(`Found ${rows.length} user_without_cv rows.\n`);

  let ok = 0;
  let fail = 0;

  for (const row of rows) {
    const cats = (row.categories || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const success = await upsertUserWithoutCv(row.id, {
        name: row.name,
        email: row.email || "",
        phone: row.phone,
        short_description: row.short_description || "",
        categories: cats,
        other_specify: row.other_specify || "",
      });
      if (success) {
        console.log(`  ✓ id=${row.id} ${row.name}`);
        ok++;
      } else {
        console.log(`  ✗ id=${row.id} — no text to embed`);
        fail++;
      }
    } catch (e) {
      console.log(`  ✗ id=${row.id} — ${e?.message || e}`);
      fail++;
    }
  }

  console.log(`\nDone. Success: ${ok}, Failed: ${fail}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

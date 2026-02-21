#!/usr/bin/env node
/**
 * Backfill AI descriptions for user_without_cv rows that don't have one.
 *
 * Usage:
 *   node scripts/backfill-ai-descriptions-user-without-cv.js
 */
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
if (require("fs").existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
} else {
  require("dotenv").config({ path: path.join(process.cwd(), ".env") });
}

const knex = require("knex");
const knexfile = require("../knexfile");
const { generateNoCvDescription } = require("../services/geminiNoCvDescription");

const env = process.env.NODE_ENV || "development";
const db = knex(knexfile[env]);

async function main() {
  console.log("Backfilling AI descriptions for user_without_cv...\n");

  if (!(process.env.GEMINI_API_KEY || process.env.GEMINI_CV_READER_API_KEY || "").trim()) {
    console.error("Missing GEMINI_API_KEY or GEMINI_CV_READER_API_KEY in .env");
    process.exit(1);
  }

  const rows = await db("user_without_cv")
    .whereNull("ai_description")
    .orWhere("ai_description", "")
    .select("*")
    .orderBy("id", "asc");

  console.log(`Found ${rows.length} rows without AI description.\n`);

  for (const row of rows) {
    try {
      const description = await generateNoCvDescription(row);
      await db("user_without_cv").where("id", row.id).update({
        ai_description: description || null,
      });
      console.log(`  ✓ id=${row.id} ${row.name}`);
    } catch (e) {
      console.log(`  ✗ id=${row.id} — ${e?.message || e}`);
    }
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

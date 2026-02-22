/**
 * Cancel all pending email queue items.
 * Deletes all rows from new_job_email_queue.
 *
 * Usage: node scripts/cancel-all-email-queue.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);

async function main() {
  const deleted = await db("new_job_email_queue").del();
  console.log(`Cancelled ${deleted} email queue item(s).`);
  await db.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

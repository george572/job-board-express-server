/**
 * Reschedule all pending new_job_email_queue items to start from now, spread over 3 hours.
 * Usage: node scripts/reschedule-queue-now.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);

const SPREAD_MS = 3 * 60 * 60 * 1000; // 3 hours

async function main() {
  const rows = await db("new_job_email_queue")
    .select("id", "send_after")
    .orderBy("id", "asc");

  if (rows.length === 0) {
    console.log("Queue is empty.");
    await db.destroy();
    return;
  }

  const now = Date.now();
  const slotSize = rows.length > 1 ? SPREAD_MS / (rows.length - 1) : 0;

  console.log(`Rescheduling ${rows.length} items from now, spread over 3 hours...`);

  for (let i = 0; i < rows.length; i++) {
    const sendAfter = new Date(now + i * slotSize);
    await db("new_job_email_queue")
      .where("id", rows[i].id)
      .update({ send_after: db.raw("?::timestamptz", [sendAfter.toISOString()]) });
    console.log(`  #${rows[i].id}: ${sendAfter.toISOString()}`);
  }

  console.log(`Done. ${rows.length} items rescheduled.`);
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

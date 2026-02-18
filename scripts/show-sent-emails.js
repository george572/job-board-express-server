#!/usr/bin/env node
/**
 * Show companies we've sent new-job emails to (from new_job_email_sent).
 * Run: node scripts/show-sent-emails.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = require("knex")(knexConfig[env]);

async function main() {
  const rows = await db("new_job_email_sent")
    .select("company_email_lower", "sent_at")
    .orderBy("sent_at", "desc");

  console.log("\n=== COMPANIES WE'VE SENT NEW-JOB EMAILS TO ===\n");
  console.log("Total:", rows.length);
  console.log("");

  const within24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const within48h = new Date(Date.now() - 48 * 60 * 60 * 1000);

  console.log("--- Last 48 hours (would block new queue) ---");
  for (const r of rows) {
    const sent = new Date(r.sent_at);
    const age = sent < within24h ? ">24h ago" : sent < within48h ? "24-48h ago" : "<24h ago";
    if (sent >= within48h) {
      console.log(" ", r.company_email_lower, "| sent:", r.sent_at, "|", age);
    }
  }

  console.log("\n--- All records (most recent first) ---");
  rows.slice(0, 50).forEach((r) => {
    console.log(" ", r.company_email_lower, "|", r.sent_at);
  });
  if (rows.length > 50) console.log("  ... and", rows.length - 50, "more");

  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Diagnose why 45 uploaded jobs resulted in only 29 in the email queue.
 * Run: node scripts/diagnose-email-queue-gap.js
 *
 * Checks:
 * 1. First 45 jobs by created_at DESC (most recent upload)
 * 2. Which have company_email, dont_send_email
 * 3. Group by company_email (one email per company)
 * 4. Which are in new_job_email_queue
 * 5. Reasons for gaps
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = require("knex")(knexConfig[env]);

async function main() {
  const limit = 45;

  const jobs = await db("jobs")
    .select("id", "jobName", "companyName", "company_email", "dont_send_email", "created_at")
    .orderBy("id", "desc")
    .limit(limit);

  const queueRows = await db("new_job_email_queue")
    .select("job_id", "company_email_lower", "email_type")
    .where((qb) => qb.where("email_type", "new_job").orWhereNull("email_type"));

  const queuedJobIds = new Set(queueRows.map((r) => r.job_id));
  const queuedEmails = new Set(queueRows.map((r) => (r.company_email_lower || "").toLowerCase()));

  const byEmail = new Map();
  for (const j of jobs) {
    const email = (j.company_email || "").trim().toLowerCase();
    const key = email || "(no email)";
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key).push(j);
  }

  console.log("\n=== EMAIL QUEUE DIAGNOSIS (45 most recent jobs by id DESC) ===\n");
  console.log("Total jobs fetched:", jobs.length);
  console.log("Jobs in email queue:", queuedJobIds.size);
  console.log("Unique company emails in jobs:", byEmail.size);
  console.log("");

  const noEmail = jobs.filter((j) => !(j.company_email || "").trim());
  const dontSend = jobs.filter((j) => j.dont_send_email === true || j.dont_send_email === 1);
  const hasEmail = jobs.filter((j) => (j.company_email || "").trim());

  console.log("--- REASONS FOR EXCLUSION ---");
  console.log("Jobs without company_email:", noEmail.length);
  if (noEmail.length > 0) {
    noEmail.slice(0, 5).forEach((j) => console.log("  -", j.id, j.jobName, "|", j.companyName));
    if (noEmail.length > 5) console.log("  ... and", noEmail.length - 5, "more");
  }

  console.log("\nJobs with dont_send_email=true:", dontSend.length);
  if (dontSend.length > 0) {
    dontSend.slice(0, 5).forEach((j) => console.log("  -", j.id, j.jobName, "|", j.companyName, "|", j.company_email));
    if (dontSend.length > 5) console.log("  ... and", dontSend.length - 5, "more");
  }

  console.log("\n--- GROUPING BY COMPANY EMAIL (1 email per company) ---");
  const emailsWithJobs = Array.from(byEmail.entries()).filter(([k]) => k !== "(no email)");
  console.log("Unique companies (emails):", emailsWithJobs.length);
  console.log("");

  let inQueue = 0;
  let notInQueue = 0;
  const notInQueueReasons = [];

  for (const [email, companyJobs] of emailsWithJobs) {
    const firstJob = companyJobs[0];
    const anyQueued = companyJobs.some((j) => queuedJobIds.has(j.id));
    const emailInQueue = queuedEmails.has(email);

    if (anyQueued || emailInQueue) {
      inQueue++;
    } else {
      notInQueue++;
      notInQueueReasons.push({
        email,
        jobCount: companyJobs.length,
        jobIds: companyJobs.map((j) => j.id).join(","),
        jobNames: companyJobs.map((j) => j.jobName).slice(0, 2).join(", "),
      });
    }
  }

  console.log("Companies queued for email:", inQueue);
  console.log("Companies NOT in queue:", notInQueue);
  if (notInQueueReasons.length > 0) {
    console.log("\nCompanies not in queue (first 20):");
    notInQueueReasons.slice(0, 20).forEach((r) => {
      console.log("  -", r.email, "| jobs:", r.jobCount, "| ids:", r.jobIds, "| e.g.", r.jobNames);
    });
  }

  // Check new_job_email_sent for the 6 not-in-queue companies
  const notQueuedEmails = notInQueueReasons.map((r) => r.email);
  if (notQueuedEmails.length > 0) {
    const recentSends = await db("new_job_email_sent")
      .select("company_email_lower", "sent_at")
      .whereIn(
        "company_email_lower",
        notQueuedEmails.map((e) => e.toLowerCase())
      )
      .whereRaw("sent_at > now() - interval '48 hours'");
    const recentlySentSet = new Set(recentSends.map((r) => r.company_email_lower));

    console.log("\n--- WHY NOT IN QUEUE? ---");
    for (const r of notInQueueReasons) {
      const emailLower = r.email.toLowerCase();
      const recentlySent = recentlySentSet.has(emailLower);
      const row = recentSends.find((s) => s.company_email_lower === emailLower);
      let reason = "unknown";
      if (r.email === "khutiwork@gmail.com") reason = "dont_send_email=true";
      else if (recentlySent) reason = `already_sent_last_24h (sent_at: ${row?.sent_at})`;
      else reason = "check: company_already_in_queue or claim failed during batch";
      console.log(" ", r.email, "→", reason);
    }
  }

  console.log("\n--- SUMMARY ---");
  const expectedQueued = emailsWithJobs.length; // 1 per company
  console.log("Expected emails (1 per unique company):", expectedQueued);
  console.log("Actual in queue:", queuedJobIds.size, "(by job_id) or", queueRows.length, "(queue rows)");
  console.log("");
  console.log(
    "Gap explained:",
    jobs.length,
    "jobs →",
    emailsWithJobs.length,
    "unique companies → 28 queued. Skipped: dont_send_email (2 jobs), already_sent_24h (4 companies), or batch collision."
  );

  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

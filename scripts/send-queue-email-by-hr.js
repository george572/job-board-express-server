/**
 * Immediately send new-job marketing email to a specific HR email.
 *
 * Usage: node scripts/send-queue-email-by-hr.js [hr_email]
 *   hr_email defaults to xutiashviligiorgi@gmail.com
 *   Requires PROPOSITIONAL_MAIL_USER and PROPOSITIONAL_MAIL_PASS in .env
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const nodemailer = require("nodemailer");
const knexConfig = require("../knexfile");
const { slugify } = require("../utils/slugify");

const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://samushao.ge";

const PROPOSITIONAL_MAIL_USER = (process.env.PROPOSITIONAL_MAIL_USER || "")
  .trim();
const PROPOSITIONAL_MAIL_PASS = (process.env.PROPOSITIONAL_MAIL_PASS || "")
  .trim()
  .replace(/\s/g, "");

function NEW_JOB_HTML_TEMPLATE(job, candidate) {
  const aiDescription =
    candidate && candidate.ai_description ? candidate.ai_description : "—";
  return `
<p>გამარჯობა!</p>

<p>ვხედავ, რომ <b>"${job.jobName}"</b>-ს პოზიციაზე ვაკანსია გაქვთ აქტიური.</p>

<p>Samushao.ge-ს AI-მ ბაზაში უკვე იპოვა 1 კანდიდატი, რომელიც თქვენს მოთხოვნებს 90%-ით ემთხვევა.</p>
<p>აი მისი მოკლე დახასიათება (გენერირებულია ჩვენი AI-ს მიერ):</p>
${aiDescription}

<p>მაინტერესებდა, ჯერ კიდევ ეძებთ კადრს?</p>

<p>თუ კი, შემიძლია გამოგიგზავნოთ მისი რეზიუმეს ბმული და თავად ნახოთ რამდენად შეესაბამება თქვენს მოთხოვნებს.</p>

<p>პატივისცემით,<br>
გიორგი | Samushao.ge</p>`;
}

async function main() {
  const hrEmail = (
    process.argv[2] || "xutiashviligiorgi@gmail.com"
  )
    .trim()
    .toLowerCase();

  if (!PROPOSITIONAL_MAIL_USER || !PROPOSITIONAL_MAIL_PASS) {
    console.error(
      "Missing PROPOSITIONAL_MAIL_USER or PROPOSITIONAL_MAIL_PASS in .env"
    );
    process.exit(1);
  }

  const rows = await db("new_job_email_queue as q")
    .leftJoin("jobs as j", "j.id", "q.job_id")
    .where("q.company_email_lower", hrEmail)
    .where((qb) =>
      qb.where("q.email_type", "new_job").orWhereNull("q.email_type")
    )
    .select(
      "q.id as queue_id",
      "q.job_id",
      "q.company_email_lower",
      "q.subject",
      "q.html",
      "j.jobName",
      "j.companyName",
      "j.company_email",
      "j.jobSalary",
      "j.jobSalary_min"
    )
    .orderBy("q.send_after");

  if (rows.length === 0) {
    console.log(`No queue items found for ${hrEmail}`);
    await db.destroy();
    process.exit(0);
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: PROPOSITIONAL_MAIL_USER, pass: PROPOSITIONAL_MAIL_PASS },
  });

  console.log(`Found ${rows.length} queue item(s) for ${hrEmail}. Sending...\n`);

  for (const row of rows) {
    const toEmail = (
      row.company_email || row.company_email_lower || ""
    )
      .trim()
      .split(/[,;]/)[0]
      .trim();
    if (!toEmail) {
      console.log(`  Skip job #${row.job_id}: no email`);
      await db("new_job_email_queue").where("id", row.queue_id).del();
      continue;
    }

    const job = {
      id: row.job_id,
      jobName: row.jobName,
      companyName: row.companyName,
      company_email: row.company_email || row.company_email_lower,
      jobSalary: row.jobSalary,
      jobSalary_min: row.jobSalary_min,
    };
    const jobLink = `${SITE_BASE_URL}/vakansia/${slugify(job.jobName)}-${job.id}`;
    const subject =
      row.subject || `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`;
    const html =
      row.html ||
      NEW_JOB_HTML_TEMPLATE({ ...job, jobLink }, { ai_description: "—" });

    try {
      await transporter.sendMail({
        from: PROPOSITIONAL_MAIL_USER,
        to: toEmail,
        subject,
        html,
      });
      console.log(`  ✓ Sent to ${toEmail} (job #${job.id}: ${job.jobName})`);

      const hasMarketingSent = await db.schema.hasColumn(
        "jobs",
        "marketing_email_sent"
      );
      if (hasMarketingSent) {
        await db("jobs")
          .where("id", row.job_id)
          .update({ marketing_email_sent: true });
      }

      await db("new_job_email_sent")
        .insert({
          company_email_lower: hrEmail,
          sent_at: db.fn.now(),
        })
        .onConflict("company_email_lower")
        .merge({ sent_at: db.fn.now() });

      await db("new_job_email_queue").where("id", row.queue_id).del();
    } catch (err) {
      console.error(
        `  ✗ Failed to ${toEmail} (job #${row.job_id}):`,
        err.message
      );
    }
  }

  console.log("\nDone.");
  await db.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

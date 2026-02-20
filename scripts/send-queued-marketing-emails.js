/**
 * One-time script: Send marketing emails for first N items in new_job_email_queue.
 *
 * Usage: node scripts/send-queued-marketing-emails.js [count]
 *   count defaults to 6
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

const PROPOSITIONAL_MAIL_USER = (process.env.PROPOSITIONAL_MAIL_USER || "").trim();
const PROPOSITIONAL_MAIL_PASS = (process.env.PROPOSITIONAL_MAIL_PASS || "").trim().replace(/\s/g, "");

function parseSalaryNum(s) {
  if (s == null || s === "") return null;
  const m = String(s).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function buildNewJobEmailHtml(job) {
  const salaryNum = parseSalaryNum(job.jobSalary ?? job.jobSalary_min);
  const salaryDisplay = job.jobSalary ? String(job.jobSalary).replace(/<[^>]*>/g, "") : "—";
  const salaryParagraph =
    salaryNum != null && salaryNum >= 1200
      ? "ვინაიდან თქვენი კომპანია იხდის " + salaryDisplay + " ლარს, გამოხმაურება ისედაც იქნება, და ამიტომ გთავაზობთ სტანდარტული პაკეტით სარგებლობას."
      : salaryNum != null && salaryNum < 1200
        ? "ვინაიდან თქვენი კომპანია იხდის " + salaryDisplay + " ლარს, გთავაზობთ პრემიუმ/პრემიუმ+ პაკეტით სარგებლობას, ასე ბევრი ადამიანი ნახავს ვაკანსიას და მაღალი შანსია რომ მეტი რელევანტური რეზიუმეები გამოიგზავნება."
        : "";

  const lowSalaryBonus =
    salaryNum != null && salaryNum < 1200
      ? "<p>რადგან ჯერ არ ვიცნობთ ერთმანეთს, გვინდა ჩვენი პლატფორმა გაგაცნოთ, და გთავაზობთ პრემიუმ+ განცხადებას 100 ლარად 250 ლარის ნაცვლად.</p>"
      : "";

  return `
<p>გამარჯობა!</p>
<p>გაცნობებთ, რომ თქვენი ვაკანსია რომელიც საჯაროდ ხელმისაწვდომია ინტერნეტში, გავაზიარეთ ჩვენს პლატფორმაზე ( samushao.ge ), თუ აღნიშული თქვენთვის მიუღებელია, გთხოვთ შეგვატყობინოთ და განცხადებას წავშლით.</p>
<p>თუ არ ხართ წინააღმდეგი, გთავაზობთ სრულიად უფასო 7 დღიან პრემიუმ სტატუსს თქვენი ვაკანსიისთვის, რადგან გამოსცადოთ ჩვენი პლატფორმა.</p>
<p>დამიდასტურეთ მეილის მიღება და თქვენს ვაკანსიას პრემიუმ სტატუსს მივანიჭებთ.</p>
<p>პატივისცემით,</p>
<p>გიორგი</p>
`;
}

async function main() {
  const count = parseInt(process.argv[2] || "6", 10) || 6;

  if (!PROPOSITIONAL_MAIL_USER || !PROPOSITIONAL_MAIL_PASS) {
    console.error("Missing PROPOSITIONAL_MAIL_USER or PROPOSITIONAL_MAIL_PASS in .env");
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: PROPOSITIONAL_MAIL_USER, pass: PROPOSITIONAL_MAIL_PASS },
  });

  const rows = await db("new_job_email_queue as q")
    .leftJoin("jobs as j", "j.id", "q.job_id")
    .where((qb) => qb.where("q.email_type", "new_job").orWhereNull("q.email_type"))
    .select(
      "q.id as queue_id",
      "q.job_id",
      "q.company_email_lower",
      "j.jobName",
      "j.companyName",
      "j.company_email",
      "j.jobSalary",
      "j.jobSalary_min"
    )
    .orderBy("q.send_after")
    .limit(count);

  if (rows.length === 0) {
    console.log("No items in queue (new_job type).");
    process.exit(0);
  }

  console.log(`Sending ${rows.length} marketing email(s)...\n`);

  for (const row of rows) {
    const toEmail = (row.company_email || row.company_email_lower || "").trim().split(/[,;]/)[0].trim();
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

    try {
      await transporter.sendMail({
        from: PROPOSITIONAL_MAIL_USER,
        to: toEmail,
        subject: `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`,
        html: buildNewJobEmailHtml({ ...job, jobLink }),
      });
      console.log(`  ✓ Sent to ${toEmail} (job #${job.id}: ${job.jobName})`);
      await db("jobs").where("id", row.job_id).update({ marketing_email_sent: true });
      await db("new_job_email_queue").where("id", row.queue_id).del();
    } catch (err) {
      console.error(`  ✗ Failed to ${toEmail} (job #${row.job_id}):`, err.message);
    }
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

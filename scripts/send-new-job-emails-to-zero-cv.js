/**
 * One-time script: Send "new job" intro email to jobs that are:
 * - Not older than 10 days
 * - Have 0 CVs sent
 *
 * Usage:
 *   node scripts/send-new-job-emails-to-zero-cv.js        → TEST mode (dry run, no send)
 *   node scripts/send-new-job-emails-to-zero-cv.js --send → actually send emails
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same logic as routes/jobs.js NEW_JOB_HTML_TEMPLATE
function parseSalaryNum(s) {
  if (s == null || s === "") return null;
  const m = String(s).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function buildNewJobEmailHtml(job) {
  const jobLink = `${SITE_BASE_URL}/vakansia/${slugify(job.jobName)}-${job.id}`;
  const salaryNum = parseSalaryNum(job.jobSalary ?? job.jobSalary_min);
  const salaryDisplay = job.jobSalary ? String(job.jobSalary).replace(/<[^>]*>/g, "") : "—";

  const salaryParagraph =
    salaryNum != null && salaryNum >= 1200
      ? "ვინაიდან თქვენი კომპანია იხდის " + salaryDisplay + " ლარს, გამოხმაურება ისედაც იქნება, და ამიტომ გთავაზობთ სტანდარტული პაკეტით სარგებლობას."
      : salaryNum != null && salaryNum < 1200
        ? "ვინაიდან თქვენი კომპანია იხდის " + salaryDisplay + " ლარს, გთავაზობთ პრემიუმ/პრემიუმ+ პაკეტით სარგებლობას, ასე ბევრი ადამიანი ნახავს ვაკანსიას და მაღალი შანსია რომ მეტი რელევანტური რეზიუმეები გამოიგზავნება."
        : "გთავაზობთ ჩვენი პაკეტების სრულ სპექტრს.";

  const lowSalaryBonus =
    salaryNum != null && salaryNum < 1200
      ? "<p>რადგან ჯერ არ ვიცნობთ ერთმანეთს, გვინდა გაგეცნოთ, და გთავაზობთ პრემიუმ+ განცხადებას 100 ლარად 250 ლარის ნაცვლად.</p>"
      : "";

  return `
<p>გამარჯობა!</p>
<p>ინტერნეტში თქვენი ვაკანსია "${job.jobName}" ვიპოვეთ და ჩვენს საიტზე (<a href="https://samushao.ge">samushao.ge</a>) განვათავსეთ, ბოდიშს გიხდით თუ ეს არ უნდა გვექნა. თუ ცალსახად წინააღმდეგი ხართ, წავშლით.</p>
<p>ხოლო თუ დაინტერესებული ხართ რომ ვაკანსია უფრო მეტმა ნახოს, გთავაზობთ ვითანამშრომლოთ.</p>
<p>ფასების შესახებ ინფორმაცია:</p>
<p>1. სტანდარტული განცხადება - 50 ლარი</p>
<p>2. პრემიუმ განცხადება - 10 დღე მთავარ გვერდზე - 70 ლარი</p>
<p>3. პრემიუმ+ განცხადება - ყველაზე მაღალი ხილვადობა, 30 დღე მთავარ გვერდზე + პრიორიტეტი "მსგავს ვაკანსიებში" - 250 ლარი</p>
<p>სტატისტიკურად, ვაკანსიები სადაც ანაზღაურება 1200 ლარი ან მეტია და გამოცდილება 2 წელზე მეტი არ მოითხოვება, კარგ გამოხმაურებას იღებენ და ბევრი რეზიუმეც იგზავნება, ხოლო თუ ანაზღაურება 1200 ლარზე ნაკლებია, ბევრი განცხადება იგნორდება.</p>
<p>${salaryParagraph}</p>
<p>${lowSalaryBonus}</p>
<p>თუ დაინტერესდებით, ვითანამშრომლოთ!</p>
`;
}

async function main() {
  const doSend = process.argv.includes("--send");

  const tenDaysAgo = new Date();
  tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

  const jobs = await db("jobs")
    .where("created_at", ">=", tenDaysAgo)
    .where(function () {
      this.where("cvs_sent", 0).orWhereNull("cvs_sent");
    })
    .whereRaw("(dont_send_email IS NOT TRUE)")
    .select("*")
    .orderBy("created_at", "desc");

  console.log(`\n=== MODE: ${doSend ? "SEND" : "TEST (dry run, no emails sent)"} ===\n`);
  console.log(`Found ${jobs.length} jobs (not older than 10 days, 0 CVs sent)\n`);

  if (jobs.length === 0) {
    console.log("No jobs to process.");
    await db.destroy();
    return;
  }

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const salaryNum = parseSalaryNum(job.jobSalary ?? job.jobSalary_min);
    const html = buildNewJobEmailHtml(job);

    console.log("─".repeat(60));
    console.log(`[${i + 1}/${jobs.length}] Job #${job.id}: ${job.jobName}`);
    console.log(`  Company: ${job.companyName}`);
    console.log(`  HR Email: ${job.company_email || "(none)"}`);
    console.log(`  Raw salary: ${JSON.stringify(job.jobSalary || job.jobSalary_min || "—")}`);
    console.log(`  Parsed salary (num): ${salaryNum ?? "null"} ${salaryNum != null ? (salaryNum >= 1200 ? "→ სტანდარტული ტექსტი" : "→ პრემიუმ ტექსტი + 100 ლარი ბონუსი") : "→ უცნობი"}`);
    console.log("\n  Full email body (plain text):");
    const plainPreview = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    console.log("  " + plainPreview);
    console.log("");

    if (doSend) {
      const email = (job.company_email || "").trim();
      if (!email) {
        console.log(`  ⏭ Skip: no company_email\n`);
        continue;
      }

      if (!PROPOSITIONAL_MAIL_USER || !PROPOSITIONAL_MAIL_PASS) {
        console.error("Missing PROPOSITIONAL_MAIL_USER or PROPOSITIONAL_MAIL_PASS. Aborting.");
        await db.destroy();
        process.exit(1);
      }

      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: PROPOSITIONAL_MAIL_USER, pass: PROPOSITIONAL_MAIL_PASS },
      });

      try {
        await transporter.sendMail({
          from: PROPOSITIONAL_MAIL_USER,
          to: email,
          subject: `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`,
          html,
        });
        console.log(`  ✅ Sent to ${email}\n`);
      } catch (err) {
        console.error(`  ❌ Failed: ${err.message}\n`);
      }

    }
  }

  await db.destroy();
  console.log("─".repeat(60));
  console.log(doSend ? "Done." : "Test complete. Run with --send to actually send emails.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

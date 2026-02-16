/**
 * One-time script: Send propositional email to HRs of jobs with more than 3 CVs sent.
 * Uses PROPOSITIONAL_MAIL_USER and PROPOSITIONAL_MAIL_PASS from .env
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const knex = require("knex");
const nodemailer = require("nodemailer");
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);

const PROPOSITIONAL_MAIL_USER = (process.env.PROPOSITIONAL_MAIL_USER || "").trim();
const PROPOSITIONAL_MAIL_PASS = (process.env.PROPOSITIONAL_MAIL_PASS || "").trim().replace(/\s/g, ""); // Gmail expects App Password without spaces

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML_TEMPLATE = (cvsSent) => `
<p>სალამი!</p>
<p>ბოდიში, ჩვენ დაუკითხავად (მაგრამ კეთილი განზრახვით) დავდეთ თქვენი ვაკანსია ჩვენს საიტზე (<a href="https://samushao.ge">samushao.ge</a>), იმედია არ გაგაბრაზეთ.</p>
<p>საკმაოდ ნახვები აქვს განცხადებას და უკვე <strong>${cvsSent}</strong> რეზიუმე გამოიგზავნა.</p>
<p>თუ არ გინახავთ აპლიკანტები, შეიძლება იმიტომ რომ სპამში მოხვდა ჩვენი გამოგზავნილი ემაილები, სპამი შეამოწმეთ.</p>
<p>თუ თქვენც მოგწონთ ამ რამოდენიმე დღის შედეგები და გინდათ თქვენი ვაკანსია დარჩეს, ჩვენთან განცხადების დადება ფასიანია.</p>
<p>თუ გნებავთ რომ თქვენი განცხადება ავიღოთ, გვითხარით - ჩვენ ბოდიშს მოგიხდით და განცხადებას ავიღებთ.</p>
<p>p.s</p>
<p>პირადი იმეილიდან მიწევს ამ ტექსტის მოწერა, არაპროფესიონალიზმში არ ჩამითვალოთ, ტექნიკური მიზეზებია.</p>
`;

async function main() {
  if (!PROPOSITIONAL_MAIL_USER || !PROPOSITIONAL_MAIL_PASS) {
    console.error("Missing PROPOSITIONAL_MAIL_USER or PROPOSITIONAL_MAIL_PASS in .env");
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: PROPOSITIONAL_MAIL_USER,
      pass: PROPOSITIONAL_MAIL_PASS,
    },
  });

  const eightDaysAgo = new Date();
  eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);

  const jobs = await db("jobs")
    .where("cvs_sent", ">", 3)
    .where("created_at", ">=", eightDaysAgo)
    .select("*");
  console.log(`Found ${jobs.length} jobs with more than 3 CVs sent`);

  for (const job of jobs) {
    const email = (job.company_email || "").trim();
    if (!email) {
      console.log(`  Skip job ${job.id} (${job.jobName}): no company_email`);
      continue;
    }

    const subject = `თქვენი ვაკანსია "${job.jobName}" - Samushao.ge`;
    const html = HTML_TEMPLATE(job.cvs_sent || 0);

    try {
      await transporter.sendMail({
        from: PROPOSITIONAL_MAIL_USER,
        to: email,
        subject,
        html,
      });
      console.log(`  Sent to ${email} (job ${job.id}: ${job.jobName}, ${job.cvs_sent} CVs)`);
    } catch (err) {
      console.error(`  Failed to send to ${email}:`, err.message);
    }

    await sleep(2000); // 2s between emails to avoid rate limit
  }

  await db.destroy();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

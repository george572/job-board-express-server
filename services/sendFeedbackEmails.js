/**
 * Send aggregated job feedback to HRs (company_email) for jobs with feedback in the last 2 days.
 * Called by cron every 2 days. If job has no feedback, no email is sent.
 */
const nodemailer = require("nodemailer");

const MAIL_USER = "info@samushao.ge";
const MAIL_PASS = (process.env.MAIL_PSW || "").trim();

const transporter =
  MAIL_USER && MAIL_PASS
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: MAIL_USER, pass: MAIL_PASS },
      })
    : null;

const PILL_LABELS = {
  competitive_salary: "კონკურენტული ანაზღაურება",
  interesting_benefits: "საინტერესო ბენეფიტები",
  flexible_schedule: "მოქნილი გრაფიკი / ჰიბრიდული",
  clear_requirements: "ნათლად ჩამოყალიბებული მოთხოვნები",
  good_reputation: "კომპანიის კარგი რეპუტაცია",
  vague_description: "ბუნდოვანი სამუშაო აღწერა",
  unrealistic_requirements: "არარეალური მოთხოვნები",
  salary_not_visible: "არ ჩანს ანაზღაურება",
  too_many_responsibilities: "ზედმეტად ბევრი პასუხისმგებლობა",
  unattractive_benefits: "არამომხიბვლელი ბენეფიტები",
};

const LIKES_PILLS = new Set([
  "competitive_salary",
  "interesting_benefits",
  "flexible_schedule",
  "clear_requirements",
  "good_reputation",
]);

function getLabel(pill) {
  return PILL_LABELS[pill] || pill;
}

async function sendFeedbackEmails(db, opts = {}) {
  const { testEmail } = opts; // when set, send to this address instead of company_email (for testing)

  if (!transporter) {
    return { ok: false, error: "Mail not configured (MAIL_PSW missing)" };
  }

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  // Only feedback from last 2 days that hasn't been emailed yet
  const rawResult = await db.raw(
    `
    SELECT jf.job_id, elem::text as pill, COUNT(*)::int as cnt
    FROM job_feedback jf,
    LATERAL jsonb_array_elements_text(jf.pills) AS elem
    WHERE jf.created_at >= ?
      AND jf.emailed_at IS NULL
    GROUP BY jf.job_id, elem
  `,
    [twoDaysAgo]
  );
  const rows = rawResult?.rows || rawResult || [];

  if (!rows || rows.length === 0) {
    if (testEmail) {
      await transporter.sendMail({
        from: MAIL_USER,
        to: testEmail.trim(),
        subject: "[Samushao] უკუკავშირის ტესტი – უკუკავშირი არ არის",
        html: "<p>Cron გაეშვა წარმატებით. ბოლო 2 დღეში უკუკავშირი არ მიღებულა.</p><p>— Samushao.ge</p>",
      });
      return { ok: true, sent: 1, skipped: 0, message: "Test: sent empty-run email to " + testEmail };
    }
    return { ok: true, sent: 0, skipped: 0, message: "No feedback in last 2 days" };
  }

  const byJob = new Map();
  for (const r of rows) {
    const jobId = r.job_id;
    const pillKey = String(r.pill || "").replace(/^"|"$/g, "").trim();
    if (!byJob.has(jobId)) byJob.set(jobId, { likes: [], dislikes: [] });
    const label = getLabel(pillKey);
    const item = `${label} (${r.cnt})`;
    if (LIKES_PILLS.has(pillKey)) {
      byJob.get(jobId).likes.push(item);
    } else {
      byJob.get(jobId).dislikes.push(item);
    }
  }

  const jobIds = [...byJob.keys()];
  const jobs = await db("jobs")
    .whereIn("id", jobIds)
    .select("id", "jobName", "companyName", "company_email");

  const jobMap = new Map(jobs.map((j) => [j.id, j]));

  let sent = 0;
  let skipped = 0;

  for (const jobId of jobIds) {
    const job = jobMap.get(jobId);
    const toEmail = testEmail ? testEmail.trim() : (job?.company_email || "").trim().split(/[,;]/)[0]?.trim();
    if (!job || !toEmail) {
      skipped++;
      continue;
    }

    const { likes, dislikes } = byJob.get(jobId);
    const likesHtml =
      likes.length > 0
        ? `<p><strong>მოგვწონს:</strong><br/>${likes.join("<br/>")}</p>`
        : "";
    const dislikesHtml =
      dislikes.length > 0
        ? `<p><strong>არ მოგვწონს:</strong><br/>${dislikes.join("<br/>")}</p>`
        : "";

    const html = `
<p>გამარჯობა,</p>
<p>ვაკანსიაზე <strong>${escapeHtml(job.jobName)}</strong> (${escapeHtml(job.companyName || "")}) ბოლო 2 დღეში მიღებული ანონიმური უკუკავშირი:</p>
${likesHtml}
${dislikesHtml}
<p>— Samushao.ge</p>
    `.trim();

    try {
      await transporter.sendMail({
        from: MAIL_USER,
        to: toEmail,
        subject: testEmail ? `[ტესტი] უკუკავშირი ვაკანსიაზე: ${job.jobName}` : `უკუკავშირი ვაკანსიაზე: ${job.jobName}`,
        html,
      });
      if (!testEmail) {
        await db("job_feedback")
          .where("job_id", jobId)
          .where("created_at", ">=", twoDaysAgo)
          .whereNull("emailed_at")
          .update({ emailed_at: db.fn.now() });
      }
      sent++;
    } catch (err) {
      console.error(`feedback email error (job ${jobId}):`, err.message);
      skipped++;
    }
  }

  return { ok: true, sent, skipped, total: jobIds.length };
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { sendFeedbackEmails };

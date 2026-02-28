/**
 * Get aggregated feedback for a job (for admin/HR dashboard).
 * Returns likes and dislikes with counts.
 */
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

async function getJobFeedback(db, jobId) {
  const job = await db("jobs")
    .where({ id: jobId })
    .select("id", "jobName", "companyName")
    .first();
  if (!job) return null;

  const [rawResult, countRow] = await Promise.all([
    db.raw(
      `
      SELECT elem::text as pill, COUNT(*)::int as cnt
      FROM job_feedback jf,
      LATERAL jsonb_array_elements_text(jf.pills) AS elem
      WHERE jf.job_id = ?
      GROUP BY elem
    `,
      [jobId]
    ),
    db("job_feedback").where("job_id", jobId).count("id as n").first(),
  ]);
  const rows = rawResult?.rows || rawResult || [];
  const feedback_count = parseInt(countRow?.n || 0, 10);

  const likes = [];
  const dislikes = [];
  let total_selections = 0;

  for (const r of rows) {
    const pillKey = String(r.pill || "").replace(/^"|"$/g, "").trim();
    const label = PILL_LABELS[pillKey] || pillKey;
    const item = { pill: pillKey, label, count: r.cnt };
    total_selections += r.cnt;
    if (LIKES_PILLS.has(pillKey)) {
      likes.push(item);
    } else {
      dislikes.push(item);
    }
  }

  likes.sort((a, b) => b.count - a.count);
  dislikes.sort((a, b) => b.count - a.count);

  return {
    job_id: job.id,
    job_name: job.jobName,
    company_name: job.companyName,
    feedback_count, // number of people who submitted feedback
    total_selections, // sum of all pill counts (each person can select 1-3)
    likes,
    dislikes,
  };
}

module.exports = { getJobFeedback };

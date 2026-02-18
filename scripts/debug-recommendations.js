/**
 * Debug script: show what recommendations would be generated for a user.
 * Run: node scripts/debug-recommendations.js 107467043369155554152
 */
require("dotenv").config();
const knex = require("knex")(require("../knexfile")[process.env.NODE_ENV || "development"]);
const db = knex;

const USER_UID = process.argv[2] || "107467043369155554152";

async function main() {
  console.log("\n=== Debug recommendations for user_uid:", USER_UID, "===\n");

  const visitor = await db("visitors").where("user_id", USER_UID).first();
  const visitorId = visitor?.id || null;
  console.log("Visitor ID:", visitorId);

  const clicks = visitorId
    ? await db("visitor_job_clicks").where("visitor_id", visitorId).select("job_id", "category_id", "job_title", "from_recommended")
    : [];
  console.log("\n--- Clicks ---");
  console.log("Count:", clicks.length);
  clicks.slice(0, 20).forEach((c) => console.log("  job_id:", c.job_id, "category:", c.category_id, "title:", (c.job_title || "").slice(0, 50)));

  const cvApps = await db("job_applications as ja")
    .join("jobs as j", "j.id", "ja.job_id")
    .where("ja.user_id", USER_UID)
    .where("j.job_status", "approved")
    .whereRaw("(j.expires_at IS NULL OR j.expires_at > NOW())")
    .select("ja.job_id", "j.category_id", "j.jobName");
  console.log("\n--- CV applications ---");
  console.log("Count:", cvApps.length);
  cvApps.slice(0, 20).forEach((a) => console.log("  job_id:", a.job_id, "category:", a.category_id, "title:", (a.jobName || "").slice(0, 50)));

  const categoryNames = await db("categories").select("id", "name").then((rows) => Object.fromEntries(rows.map((r) => [r.id, r.name])));
  const categoryVisitCounts = {};
  clicks.forEach((c) => {
    if (c.category_id != null) categoryVisitCounts[c.category_id] = (categoryVisitCounts[c.category_id] || 0) + 1;
  });
  const highVisitCategoryIds = Object.keys(categoryVisitCounts)
    .filter((cid) => categoryVisitCounts[cid] >= 3)
    .map(Number);
  console.log("\n--- Category visit counts ---");
  Object.entries(categoryVisitCounts).forEach(([cid, cnt]) =>
    console.log("  category", cid, "(" + (categoryNames[cid] || "?") + "):", cnt, "visits", cnt >= 3 ? "[HIGH-VISIT]" : "")
  );
  console.log("High-visit categories (>=3):", highVisitCategoryIds.map((c) => c + " " + (categoryNames[c] || "?")).join(", ") || "none");

  const STOPWORDS = new Set(
    ["მენეჯერი", "სპეციალისტი", "ასისტენტი", "ოპერატორი", "აგენტი", "წარმომადგენელი", "კონსულტანტი", "ანალიტიკოსი", "ექსპერტი", "შემსრულებელი", "მუშაკი", "თანამშრომელი", "ვაკანსია", "სამუშაო"].map((x) => x.toLowerCase())
  );
  const extractWords = (titles) =>
    titles
      .flatMap((t) => (t || "").trim().split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase())))
      .slice(0, 12);
  const titleWords = extractWords(clicks.map((c) => c.job_title));
  const cvTitleWords = extractWords(cvApps.map((a) => a.jobName));
  const kwWords = titleWords.slice(0, 8);
  const cvKwWords = cvTitleWords.slice(0, 8);
  console.log("\n--- Extracted keywords ---");
  console.log("From clicks:", kwWords);
  console.log("From CV apps:", cvKwWords);

  const clickedCategoryIds = [...new Set(clicks.map((c) => c.category_id).filter((n) => n != null))];
  const cvCategoryIds = [...new Set(cvApps.map((a) => a.category_id).filter((n) => n != null))];
  const allCategoryIds = [...new Set([...clickedCategoryIds, ...cvCategoryIds])];
  console.log("\n--- Category IDs used for matching ---");
  console.log("From clicks:", clickedCategoryIds.map((c) => c + " " + (categoryNames[c] || "?")).join(", ") || "none");
  console.log("From CV:", cvCategoryIds.map((c) => c + " " + (categoryNames[c] || "?")).join(", ") || "none");
  console.log("All:", allCategoryIds.map((c) => c + " " + (categoryNames[c] || "?")).join(", "));

  const clickedJobIdsToExclude = [...new Set(clicks.filter((c) => !c.from_recommended).map((c) => c.job_id).filter(Boolean))];
  const cvJobIds = [...new Set(cvApps.map((a) => a.job_id))];
  const allExclude = [...new Set([...clickedJobIdsToExclude, ...cvJobIds])];

  let baseQuery = db("jobs")
    .select("*")
    .where("job_status", "approved")
    .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
    .whereNotIn("id", allExclude.length > 0 ? allExclude : [0]);

  if (allCategoryIds.length > 0 || kwWords.length > 0 || cvKwWords.length > 0 || highVisitCategoryIds.length > 0) {
    baseQuery = baseQuery.andWhere((qb) => {
      let first = true;
      if (allCategoryIds.length > 0) {
        qb.whereIn("category_id", allCategoryIds);
        first = false;
      }
      const extraCat = highVisitCategoryIds.filter((cid) => !allCategoryIds.includes(cid));
      if (extraCat.length > 0) {
        if (first) qb.whereIn("category_id", highVisitCategoryIds);
        else qb.orWhereIn("category_id", highVisitCategoryIds);
        first = false;
      }
      for (const word of kwWords) {
        const esc = "%" + String(word).replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
        first ? qb.whereRaw('"jobName" ILIKE ?', [esc]) : qb.orWhereRaw('"jobName" ILIKE ?', [esc]);
        first = false;
      }
      for (const word of cvKwWords) {
        if (kwWords.includes(word)) continue;
        const esc = "%" + String(word).replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
        first ? qb.whereRaw('"jobName" ILIKE ?', [esc]) : qb.orWhereRaw('"jobName" ILIKE ?', [esc]);
        first = false;
      }
    });
  }

  const candidates = await baseQuery.limit(500);
  console.log("\n--- Candidate count (before scoring) ---");
  console.log(candidates.length);

  function scoreJob(job) {
    let score = 0;
    let keywordMatches = 0;
    if (clickedCategoryIds.length > 0 && clickedCategoryIds.includes(job.category_id)) score += 2;
    if (cvCategoryIds.length > 0 && cvCategoryIds.includes(job.category_id)) score += 4;
    if (highVisitCategoryIds.length > 0 && highVisitCategoryIds.includes(job.category_id)) score += 3;
    const jobNameLower = (job.jobName || "").toLowerCase();
    for (const word of kwWords) {
      if (jobNameLower.includes(word.toLowerCase())) {
        score += 1;
        keywordMatches += 1;
      }
    }
    for (const word of cvKwWords) {
      if (jobNameLower.includes(word.toLowerCase())) {
        score += 2;
        keywordMatches += 1;
      }
    }
    return { score, keywordMatches };
  }

  const BROAD_CATEGORIES = new Set([19]);
  const hasKeywordSignal = kwWords.length > 0 || cvKwWords.length > 0;
  const scored = candidates
    .map((j) => ({ job: j, ...scoreJob(j) }))
    .filter((s) => {
      if (s.score < 2) return false;
      const isHighVisit = highVisitCategoryIds.length > 0 && highVisitCategoryIds.includes(s.job.category_id);
      const isBroadCat = BROAD_CATEGORIES.has(s.job.category_id);
      if (hasKeywordSignal && s.keywordMatches === 0 && !isHighVisit) return false;
      if (isHighVisit && isBroadCat && s.keywordMatches === 0) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const deduped = scored.filter((s) => {
    const key = (s.job.jobName || "").trim() + "|" + (s.job.companyName || "").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log("\n--- Recommended jobs (first 20) ---");
  deduped.slice(0, 20).forEach((s, i) => {
    console.log((i + 1) + ". [score " + s.score + "]", s.job.jobName, "|", s.job.companyName, "| cat:", s.job.category_id, "(" + (categoryNames[s.job.category_id] || "?") + ")");
  });

  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

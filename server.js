require("dotenv").config();
require("./instrument");
const express = require("express");
const Sentry = require("@sentry/node");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;
const path = require("path");
const knex = require("knex");
const knexfile = require("./knexfile");
const environment = process.env.NODE_ENV || "development";
const db = knex(knexfile[environment]);
const { slugify, extractIdFromSlug } = require("./utils/slugify");
const { JOBS_LIST_COLUMNS } = require("./utils/jobColumns");
const { parseJobIdsFromCookie } = require("./utils/formSubmittedCookie");
const NodeCache = require("node-cache");

const app = express();
const pageCache = new NodeCache({ stdTTL: 86400 }); // 24 hours
app.locals.pageCache = pageCache;
const port = process.env.PORT || 4000;
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);

// Base URL for SEO (sitemap, robots, canonicals)
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://samushao.ge";

// Georgia timezone for date comparisons – created_at is timestamptz
const TZ_GEORGIA = "Asia/Tbilisi";
const DATE_IN_GEORGIA = `(created_at AT TIME ZONE '${TZ_GEORGIA}')::date`;
const TODAY_IN_GEORGIA = `(NOW() AT TIME ZONE '${TZ_GEORGIA}')::date`;

let lastPremiumExpiryCleanup = 0;
let lastPineconeExpiredJobsCleanup = 0;
const PREMIUM_EXPIRY_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

async function runPremiumExpiryCleanup() {
  if (Date.now() - lastPremiumExpiryCleanup < PREMIUM_EXPIRY_CLEANUP_INTERVAL_MS) return;
  lastPremiumExpiryCleanup = Date.now();
  try {
    const result = await db.raw(
      `UPDATE jobs SET job_premium_status = 'regular'
       WHERE job_premium_status IN ('premium','premiumPlus')
       AND premium_until IS NOT NULL
       AND premium_until < (NOW() AT TIME ZONE 'Asia/Tbilisi')::date`
    );
    const n = result?.rowCount ?? result?.[1] ?? 0;
    if (n > 0) console.log("[premium expiry] Cleared", n, "expired premium job(s)");
  } catch (e) {
    console.error("premium expiry cleanup error:", e?.message);
  }
}

async function runExpiredJobsPineconeCleanup() {
  if (Date.now() - lastPineconeExpiredJobsCleanup < PREMIUM_EXPIRY_CLEANUP_INTERVAL_MS) return;
  if (!(process.env.PINECONE_API_KEY || "").trim()) return;
  lastPineconeExpiredJobsCleanup = Date.now();
  try {
    const { deleteJobs } = require("./services/pineconeJobs");
    const rows = await db("jobs")
      .whereNotNull("expires_at")
      .where("expires_at", "<", db.fn.now())
      .select("id");
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await deleteJobs(ids);
      console.log("[pinecone] Removed", ids.length, "expired job(s) from jobs index");
    }
  } catch (e) {
    console.error("pinecone expired jobs cleanup error:", e?.message);
  }
}

// Sentinel category ID for personalized recommendations (no jobs have this category_id)
const RECOMMENDED_CATEGORY_ID = 9999;

const cvFitCache = require("./services/cvFitCache");

/**
 * Get personalized job recommendations based on visitor's past clicks.
 * Picks the top N jobs ranked by relevance: category match + title keyword overlap.
 * Excludes already-clicked jobs. Sort: relevance DESC, then premium/prioritized, then created_at.
 */
async function getRecommendedJobs(db, visitorId, opts = {}) {
  const {
    limit = 20,
    offset = 0,
    min_salary,
    job_experience,
    job_type,
    job_city,
    searchQuery,
    userUid,
  } = opts;

  if (!visitorId && !userUid) {
    return { jobs: [], total: 0 };
  }

  const IGNORED_CATEGORY_OTHER = 19;
  const STOPWORDS = new Set(
    [
      "მენეჯერი", "სპეციალისტი", "ასისტენტი", "ოპერატორი", "აგენტი",
      "წარმომადგენელი", "კონსულტანტი", "ანალიტიკოსი", "ექსპერტი",
      "შემსრულებელი", "მუშაკი", "თანამშრომელი", "ვაკანსია", "სამუშაო",
    ].map((x) => x.toLowerCase())
  );
  const extractWords = (titles) =>
    titles
      .flatMap((t) => (t || "").trim().split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase())))
      .slice(0, 12);

  let clickedJobIdsToExclude = [];
  let clickedCategoryIds = [];
  let titleWords = [];
  let highVisitCategoryIds = [];
  let clicks = [];
  if (visitorId) {
    clicks = await db("visitor_job_clicks")
      .where("visitor_id", visitorId)
      .select("job_id", "category_id", "job_title", "from_recommended");
    if (clicks && clicks.length > 0) {
      clickedJobIdsToExclude = [...new Set(
        clicks.filter((c) => !c.from_recommended).map((c) => c.job_id).filter(Boolean)
      )];
      clickedCategoryIds = [...new Set(clicks.map((c) => c.category_id).filter((n) => n != null && !isNaN(n)))];
      titleWords = extractWords(clicks.map((c) => c.job_title));
      const categoryVisitCounts = {};
      clicks.forEach((c) => {
        if (c.category_id != null && !isNaN(c.category_id)) {
          categoryVisitCounts[c.category_id] = (categoryVisitCounts[c.category_id] || 0) + 1;
        }
      });
      highVisitCategoryIds = Object.keys(categoryVisitCounts)
        .filter((cid) => categoryVisitCounts[cid] >= 3)
        .map((n) => parseInt(n, 10));
    }
  }

  let cvJobIds = [];
  let cvCategoryIds = [];
  let cvTitleWords = [];
  let cvApplicationsQb = db("job_applications as ja")
    .join("jobs as j", "j.id", "ja.job_id")
    .where("j.job_status", "approved")
    .whereRaw("(j.expires_at IS NULL OR j.expires_at > NOW())")
    .select("ja.job_id", "j.category_id", "j.jobName");
  if (visitorId && userUid) {
    cvApplicationsQb = cvApplicationsQb.andWhere((qb) =>
      qb.where("ja.visitor_id", visitorId).orWhere("ja.user_id", userUid)
    );
  } else if (visitorId) {
    cvApplicationsQb = cvApplicationsQb.where("ja.visitor_id", visitorId);
  } else if (userUid) {
    cvApplicationsQb = cvApplicationsQb.where("ja.user_id", userUid);
  } else {
    cvApplicationsQb = cvApplicationsQb.whereRaw("1=0");
  }
  const cvApplications = await cvApplicationsQb;
  if (cvApplications && cvApplications.length > 0) {
    cvJobIds = [...new Set(cvApplications.map((a) => a.job_id).filter(Boolean))];
    cvCategoryIds = [...new Set(cvApplications.map((a) => a.category_id).filter((n) => n != null && !isNaN(n)))];
    cvTitleWords = extractWords(cvApplications.map((a) => a.jobName));
  }

  const appliedJobIdsToExclude = cvJobIds;
  // Always exclude applied jobs. For clicked jobs: don't exclude if premium/premiumPlus/prioritize (show in recommendations)
  let allExclude = [...appliedJobIdsToExclude];
  if (clickedJobIdsToExclude.length > 0) {
    const premiumRows = await db("jobs")
      .whereIn("id", clickedJobIdsToExclude)
      .where((qb) =>
        qb.whereIn("job_premium_status", ["premium", "premiumPlus"]).orWhere("prioritize", true).orWhere("prioritize", 1)
      )
      .select("id");
    const premiumOrPrioritizedIds = (premiumRows || []).map((r) => r.id);
    const premiumSet = new Set(premiumOrPrioritizedIds || []);
    const clickedToExclude = clickedJobIdsToExclude.filter((id) => !premiumSet.has(id));
    allExclude = [...new Set([...allExclude, ...clickedToExclude])];
  }
  const allCategoryIds = [...new Set([...clickedCategoryIds, ...cvCategoryIds])];
  const kwWords = titleWords.slice(0, 8);
  const cvKwWords = cvTitleWords.slice(0, 8);

  if (allCategoryIds.length === 0 && kwWords.length === 0 && cvKwWords.length === 0 && highVisitCategoryIds.length === 0) {
    return { jobs: [], total: 0 };
  }

  let baseQuery = db("jobs")
    .select(...JOBS_LIST_COLUMNS)
    .where("job_status", "approved")
    .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
    .whereNot("category_id", IGNORED_CATEGORY_OTHER)
    .whereNotIn("id", allExclude.length > 0 ? allExclude : [0]);

  if (allCategoryIds.length > 0 || kwWords.length > 0 || cvKwWords.length > 0 || highVisitCategoryIds.length > 0) {
    baseQuery = baseQuery.andWhere((qb) => {
      let first = true;
      if (allCategoryIds.length > 0) {
        qb.whereIn("category_id", allCategoryIds);
        first = false;
      }
      if (highVisitCategoryIds.length > 0) {
        const extraCat = highVisitCategoryIds.filter((cid) => !allCategoryIds.includes(cid));
        if (extraCat.length > 0) {
          if (first) {
            qb.whereIn("category_id", highVisitCategoryIds);
            first = false;
          } else {
            qb.orWhereIn("category_id", highVisitCategoryIds);
          }
        }
      }
      for (const word of kwWords) {
        const escaped = "%" + String(word).replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
        if (first) {
          qb.whereRaw('"jobName" ILIKE ?', [escaped]);
          first = false;
        } else {
          qb.orWhereRaw('"jobName" ILIKE ?', [escaped]);
        }
      }
      for (const word of cvKwWords) {
        if (kwWords.includes(word)) continue;
        const escaped = "%" + String(word).replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
        if (first) {
          qb.whereRaw('"jobName" ILIKE ?', [escaped]);
          first = false;
        } else {
          qb.orWhereRaw('"jobName" ILIKE ?', [escaped]);
        }
      }
    });
  }

  if (min_salary) {
    const min = parseInt(min_salary, 10);
    if (!isNaN(min)) baseQuery = baseQuery.where("jobSalary_min", ">=", min);
  }
  if (job_experience) {
    const exp = Array.isArray(job_experience) ? job_experience : [job_experience];
    if (exp.length > 0) baseQuery = baseQuery.whereIn("job_experience", exp);
  }
  if (job_type) {
    const types = Array.isArray(job_type) ? job_type : [job_type];
    if (types.length > 0) baseQuery = baseQuery.whereIn("job_type", types);
  }
  if (job_city) {
    const cities = Array.isArray(job_city) ? job_city : [job_city];
    if (cities.length > 0) baseQuery = baseQuery.whereIn("job_city", cities);
  }
  if (searchQuery && String(searchQuery).trim()) {
    const term =
      "%" + String(searchQuery).trim().replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
    baseQuery = baseQuery.andWhereRaw(
      '("jobName" ILIKE ? OR "companyName" ILIKE ? OR COALESCE("jobDescription", \'\') ILIKE ?)',
      [term, term, term]
    );
  }

  const candidates = await baseQuery.limit(500);

  const cvTitles = [...new Set(cvApplications.map((a) => (a.jobName || "").trim()).filter((t) => t.length >= 5))];
  const clickTitles = [...new Set(clicks.map((c) => (c.job_title || "").trim()).filter((t) => t.length >= 5))];

  function scoreJob(job) {
    let score = 0;
    let keywordMatches = 0;
    if (clickedCategoryIds.length > 0 && clickedCategoryIds.includes(job.category_id)) score += 2;
    if (cvCategoryIds.length > 0 && cvCategoryIds.includes(job.category_id)) score += 4;
    if (highVisitCategoryIds.length > 0 && highVisitCategoryIds.includes(job.category_id)) score += 3;
    const jobNameLower = (job.jobName || "").toLowerCase();
    for (const phrase of cvTitles.slice(0, 5)) {
      if (phrase.length >= 6 && jobNameLower.includes(phrase.toLowerCase())) {
        score += 5;
        keywordMatches += 1;
      }
    }
    for (const phrase of clickTitles.slice(0, 5)) {
      if (phrase.length >= 6 && jobNameLower.includes(phrase.toLowerCase())) {
        score += 3;
        keywordMatches += 1;
      }
    }
    for (const word of kwWords) {
      if (jobNameLower.includes(word.toLowerCase())) {
        score += 1;
        keywordMatches += 1;
      }
    }
    for (const word of cvKwWords) {
      if (jobNameLower.includes(word.toLowerCase())) {
        score += 3;
        keywordMatches += 1;
      }
    }
    return { score, keywordMatches };
  }

  const hasKeywordSignal = kwWords.length > 0 || cvKwWords.length > 0;
  const scored = candidates
    .map((j) => ({ job: j, ...scoreJob(j) }))
    .filter((s) => {
      if (s.score < 2) return false;
      const isHighVisitCategory = highVisitCategoryIds.length > 0 && highVisitCategoryIds.includes(s.job.category_id);
      if (hasKeywordSignal && s.keywordMatches === 0 && !isHighVisitCategory) return false;
      return true;
    });
  // Sort: premium+prioritize > premium only > prioritize only > regular; within premium: premiumPlus > premium
  const sortRank = (j) => {
    const premium = ["premium", "premiumPlus"].includes(j.job_premium_status);
    const prior = j.prioritize === true || j.prioritize === 1;
    if (premium && prior) return j.job_premium_status === "premiumPlus" ? 0 : 1;
    if (premium) return j.job_premium_status === "premiumPlus" ? 2 : 3;
    if (prior) return 4;
    return 5;
  };
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aR = sortRank(a.job);
    const bR = sortRank(b.job);
    if (aR !== bR) return aR - bR;
    return new Date(b.job.created_at) - new Date(a.job.created_at);
  });

  const seenKey = new Set();
  const deduped = [];
  for (const { job } of scored) {
    const key = String(job.jobName || "").trim() + "|" + String(job.companyName || "").trim();
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    deduped.push(job);
  }

  const total = deduped.length;
  let jobs = deduped.slice(offset, offset + limit);

  // Premium (not prioritized) in second position: move first premium job to slot 2 (index 1)
  if (jobs.length >= 2) {
    const isPremium = (j) => ["premium", "premiumPlus"].includes(j.job_premium_status);
    const premiumIdx = jobs.findIndex((j) => isPremium(j));
    if (premiumIdx > 1) {
      const [first, , ...rest] = jobs;
      const premium = jobs[premiumIdx];
      const restWithoutPremium = jobs.filter((_, i) => i !== 0 && i !== premiumIdx);
      jobs = [first, premium, ...restWithoutPremium];
    }
  }

  return { jobs, total };
}

// Behind Fly/Heroku we must trust the proxy so secure cookies work
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// Session options: Postgres store in production, memory in dev
const sessionOptions = {
  resave: false,
  secret: process.env.SESSION_SECRET || "askmdaksdhjkqjqkqkkq1",
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: "lax",
  },
};

if (process.env.NODE_ENV === "production") {
  sessionOptions.store = new pgSession({
    conString: process.env.DATABASE_URL,
    tableName: "session",
    createTableIfMissing: true,
  });
}

// Session middleware MUST come before the route
app.use(session(sessionOptions));

// Then your res.locals middleware
const ENLISTED_FB_COOKIE = "enlisted_fb";
const NO_CV_BANNER_COOKIE = "no_cv_banner_dismissed";
function hasCookie(req, name) {
  const raw = req?.headers?.cookie || "";
  return new RegExp(`\\b${name}=([^;]+)`).test(raw);
}
function hasEnlistedFbCookie(req) {
  return hasCookie(req, ENLISTED_FB_COOKIE);
}
app.use((req, res, next) => {
  res.locals.user = req.session?.user || null;
  res.locals.enlistedInFb = hasCookie(req, ENLISTED_FB_COOKIE);
  res.locals.showNoCvBanner = !req.session?.user && !hasCookie(req, NO_CV_BANNER_COOKIE);
  next();
});

const { visitorMiddleware } = require("./middleware/visitor");
app.use(visitorMiddleware(db, extractIdFromSlug));

// After visitor: upgrade enlistedInFb from DB if user/visitor has interacted
app.use(async (req, res, next) => {
  if (res.locals.enlistedInFb) return next();
  const userId = req.session?.user?.uid;
  const visitorId = req.visitorId;
  if (!userId && !visitorId) return next();
  try {
    let q = db("enlisted_in_fb");
    if (userId && visitorId) {
      q = q.whereRaw("(user_id = ? OR visitor_id = ?)", [userId, visitorId]);
    } else if (userId) {
      q = q.where("user_id", userId);
    } else {
      q = q.where("visitor_id", visitorId);
    }
    const found = await q.first();
    if (found) res.locals.enlistedInFb = true;
  } catch (e) {
    /* ignore */
  }
  next();
});

// Page cache: serve cached HTML for anonymous visitors (24h)
// Runs after visitor middleware so req.visitorId is set for job view tracking on cache hits
const CACHEABLE_PATHS = /^\/(vakansia\/[^/]+|kvelaze-motkhovnadi-vakansiebi|kvelaze-magalanazgaurebadi-vakansiebi|dgevandeli-vakansiebi|rekomendebuli-vakansiebi|vakansiebi-cv-gareshe|vakansiebi-shentvis|privacy-policy|terms-of-use|pricing)(\?.*)?$/;
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.session?.user) return next();
  const pathOnly = req.path;
  if (pathOnly === "/" || CACHEABLE_PATHS.test(pathOnly)) {
    const key = req.originalUrl || req.url;
    const cached = pageCache.get(key);
    if (cached) {
      // For job detail pages: record view_count and visitor_job_clicks on cache hit
      const jobMatch = pathOnly.match(/^\/vakansia\/(.+)$/);
      if (jobMatch) {
        const jobIdRaw = extractIdFromSlug(jobMatch[1]);
        const jobId = jobIdRaw ? parseInt(jobIdRaw, 10) : null;
        if (jobId && !isNaN(jobId)) {
          db.raw("UPDATE jobs SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?", [jobId]).catch((e) =>
            console.error("view_count increment error:", e?.message)
          );
          if (req.visitorId) {
            db("jobs").where({ id: jobId }).first().then((job) => {
              if (!job) return;
              const catPromise = job.category_id
                ? db("categories").where("id", job.category_id).select("name").first()
                : Promise.resolve(null);
              return catPromise.then((cat) =>
                db("visitor_job_clicks").insert({
                  visitor_id: req.visitorId,
                  job_id: jobId,
                  job_salary: job.jobSalary || null,
                  job_title: job.jobName || null,
                  category_id: job.category_id || null,
                  job_category_name: (cat && cat.name) || null,
                  job_city: job.job_city || null,
                  job_experience: job.job_experience || null,
                  job_type: job.job_type || null,
                  from_recommended: req.query.from === "recommended",
                })
              );
            }).catch((e) => console.error("visitor_job_clicks insert error:", e?.message));
          }
        }
      }
      return res.set("Content-Type", "text/html; charset=utf-8").send(cached);
    }
    const origSend = res.send.bind(res);
    res.send = function (body) {
      if (typeof body === "string" && (body.startsWith("<!") || body.startsWith("<html"))) {
        pageCache.set(key, body);
      }
      return origSend(body);
    };
  }
  next();
});

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

app.use(
  cors({
    origin: [
      "http://localhost:4000",
      "http://localhost:4001",
      "https://samushao.ge",
      "https://samushao-admin.web.app",
      "http://localhost:3000"
    ],
    credentials: true,
  }),
);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static("uploads"));

// Redirect trailing slash to clean URL (prevents duplicate canonicals)
// Only for GET/HEAD – redirecting POST etc. would lose the request body
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    if (req.path.endsWith("/") && req.path.length > 1) {
      return res.redirect(301, req.path.slice(0, -1) + (req.url.slice(req.path.length) || ""));
    }
  }
  next();
});

// Set up view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// --- robots.txt (dynamic)
app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.send(
    `User-agent: *
Allow: /

Disallow: /my-applications
Disallow: /my-cv

Sitemap: ${SITE_BASE_URL}/sitemap.xml
`,
  );
});

// --- sitemap.xml (dynamic, no cache so it reflects new jobs)
app.get("/sitemap.xml", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  try {
    const jobs = await db("jobs")
      .select("id", "jobName", "updated_at", "created_at")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .orderBy("id", "asc");

    const toDate = (d) => {
      if (!d) return null;
      const date = new Date(d);
      return date.toISOString().slice(0, 10);
    };

    const urls = [
      {
        loc: SITE_BASE_URL + "/",
        lastmod: toDate(new Date()),
        changefreq: "daily",
        priority: "1.0",
      },
      {
        loc: SITE_BASE_URL + "/pricing",
        lastmod: toDate(new Date()),
        changefreq: "monthly",
        priority: "0.8",
      },
      {
        loc: SITE_BASE_URL + "/privacy-policy",
        lastmod: toDate(new Date()),
        changefreq: "monthly",
        priority: "0.5",
      },
      {
        loc: SITE_BASE_URL + "/kvelaze-magalanazgaurebadi-vakansiebi",
        lastmod: toDate(new Date()),
        changefreq: "daily",
        priority: "0.9",
      },
      {
        loc: SITE_BASE_URL + "/kvelaze-motkhovnadi-vakansiebi",
        lastmod: toDate(new Date()),
        changefreq: "daily",
        priority: "0.9",
      },
      {
        loc: SITE_BASE_URL + "/dgevandeli-vakansiebi",
        lastmod: toDate(new Date()),
        changefreq: "daily",
        priority: "0.9",
      },
      ...jobs.map((job) => ({
        loc: `${SITE_BASE_URL}/vakansia/${slugify(job.jobName)}-${job.id}`,
        lastmod: toDate(job.updated_at || job.created_at),
        changefreq: "weekly",
        priority: "0.7",
      })),
    ];

    const escapeXml = (s) =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls
        .map(
          (u) =>
            `  <url>\n    <loc>${escapeXml(u.loc)}</loc>\n` +
            (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : "") +
            (u.changefreq
              ? `    <changefreq>${u.changefreq}</changefreq>\n`
              : "") +
            (u.priority ? `    <priority>${u.priority}</priority>\n` : "") +
            "  </url>",
        )
        .join("\n") +
      "\n</urlset>";

    res.type("application/xml");
    res.send(xml);
  } catch (err) {
    console.error("sitemap error:", err);
    res.status(500).send("Error generating sitemap");
  }
});

// Home route
app.get("/", async (req, res) => {
  try {
    runPremiumExpiryCleanup().catch(() => {});
    runExpiredJobsPineconeCleanup().catch(() => {});

    const {
      category,
      company,
      job_experience,
      job_type,
      job_city,
      page = 1,
      limit: limitParam = 5,
      hasSalary,
      job_premium_status,
      min_salary,
      q: searchQuery,
      append,
    } = req.query;

    const limit = Number(limitParam);
    const pageNum = Number(page);
    const isAppendRequest = append === "1";

    if (isAppendRequest) {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      res.set("Pragma", "no-cache");
    }

    const filterParamKeys = [
      "category",
      "company",
      "job_experience",
      "job_type",
      "job_city",
      "hasSalary",
      "job_premium_status",
      "min_salary",
      "q",
    ];
    const filtersActive = filterParamKeys.some((key) => {
      const v = req.query[key];
      if (v === undefined || v === "") return false;
      return Array.isArray(v) ? v.length > 0 : true;
    });

    const offset = isAppendRequest
      ? (pageNum - 1) * limit
      : 0;
    const fetchLimit = isAppendRequest
      ? limit
      : pageNum * limit;

    // Recommended jobs at top (personalized by visitor clicks + CV sends) – only when no filters
    // Skip for append requests (load more) – client only needs jobs list
    let recommendedJobs = [];
    let topSalaryJobs = [];
    let topSalaryTotalCount = 0;
    let topPopularJobs = [];
    let topPopularTotalCount = 0;
    let todayJobs = [];
    let todayJobsCount = 0;
    let topCvFitJobs = [];
    let topCvFitTotalCount = 0;
    let formSubmissionJobs = [];
    let formSubmissionTotalCount = 0;

    // Defer below-fold sections (today's jobs, main jobs) on initial load when no filters – load on scroll
    const deferBelowFold = !isAppendRequest && !filtersActive;

    if (!isAppendRequest) {
    if (!filtersActive && (req.visitorId || req.session?.user?.uid)) {
      const rec = await getRecommendedJobs(db, req.visitorId, {
        limit: 20,
        offset: 0,
        userUid: req.session?.user?.uid,
      });
      if (rec.jobs && rec.jobs.length > 0) {
        recommendedJobs = rec.jobs;
      }
    }

    // Top salary jobs slider – skip when any filters are active
    if (!filtersActive) {
      // Top salary: slot 1 = highest paid non-boosted; slots 2-3 = premium first, then prioritized (premium > prioritize)
        const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || j.prioritize === "true" || ["premium", "premiumPlus"].includes(j.job_premium_status);
        let topSalaryRaw = await db("jobs")
          .select(...JOBS_LIST_COLUMNS)
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .whereNotNull("jobSalary_min")
          .orderBy("jobSalary_min", "desc")
          .limit(50);
        const prioritizedWithSalary = await db("jobs")
          .select(...JOBS_LIST_COLUMNS)
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .where((qb) => qb.where("prioritize", true).orWhereIn("job_premium_status", ["premium", "premiumPlus"]))
          .whereNotNull("jobSalary_min")
          .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
          .orderBy("jobSalary_min", "desc")
          .limit(2);
        const topSeen = new Set();
        topSalaryRaw = topSalaryRaw.filter((j) => {
          const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
          if (topSeen.has(key)) return false;
          topSeen.add(key);
          return true;
        });
        const dedupePrioritized = [];
        const seenP = new Set();
        for (const j of prioritizedWithSalary) {
          const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
          if (!seenP.has(key)) {
            seenP.add(key);
            dedupePrioritized.push(j);
          }
        }
        const nonBoosted = topSalaryRaw.filter((j) => !isBoosted(j));
        const slot1 = (nonBoosted[0] || topSalaryRaw[0]);
        const prioritizedFor23 = dedupePrioritized.slice(0, 2);
        const usedIds = new Set([slot1?.id, ...prioritizedFor23.map((j) => j.id)].filter(Boolean));
        const restBySalary = topSalaryRaw.filter((j) => !usedIds.has(j.id));
        const minPremiumSalaryForTopSalary = 2000;
        const includePremiumInTopSalary = (j) => {
          if (!j) return false;
          const isPremium = ["premium", "premiumPlus"].includes(j.job_premium_status);
          if (isPremium) {
            const salary = parseInt(j.jobSalary_min, 10) || 0;
            return salary >= minPremiumSalaryForTopSalary;
          }
          return true;
        };
        topSalaryJobs = [slot1, ...prioritizedFor23, ...restBySalary]
          .filter(Boolean)
          .filter(includePremiumInTopSalary)
          .slice(0, 20);
        topSalaryTotalCount = topSalaryJobs.length;

      // Top popular: slot 1 = most viewed non-boosted; slots 2-3 = premium first, then prioritized
        let topPopularRaw = await db("jobs")
          .select(...JOBS_LIST_COLUMNS)
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .orderByRaw("COALESCE(view_count, 0) DESC")
          .limit(50);
        const prioritizedForPopular = await db("jobs")
          .select(...JOBS_LIST_COLUMNS)
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .where((qb) => qb.where("prioritize", true).orWhereIn("job_premium_status", ["premium", "premiumPlus"]))
          .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
          .orderByRaw("COALESCE(view_count, 0) DESC")
          .limit(2);
        const seenPop = new Set();
        topPopularRaw = topPopularRaw.filter((j) => {
          const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
          if (seenPop.has(key)) return false;
          seenPop.add(key);
          return true;
        });
        const dedupePrioritizedPop = [];
        const seenPPop = new Set();
        for (const j of prioritizedForPopular) {
          const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
          if (!seenPPop.has(key)) {
            seenPPop.add(key);
            dedupePrioritizedPop.push(j);
          }
        }
        const nonBoostedPop = topPopularRaw.filter((j) => !isBoosted(j));
        const slot1Pop = (nonBoostedPop[0] || topPopularRaw[0]);
        const prioritizedFor23Pop = dedupePrioritizedPop.slice(0, 2);
        const usedIdsPop = new Set([slot1Pop?.id, ...prioritizedFor23Pop.map((j) => j.id)].filter(Boolean));
        const restByViews = topPopularRaw.filter((j) => !usedIdsPop.has(j.id));
        topPopularJobs = [slot1Pop, ...prioritizedFor23Pop, ...restByViews].filter(Boolean).slice(0, 20);
        topPopularTotalCount = topPopularJobs.length;

      // Today's jobs (დღევანდელი ვაკანსიები) – skipped when deferBelowFold (loaded on scroll)
      if (!deferBelowFold) {
        todayJobs = await db("jobs")
          .select(...JOBS_LIST_COLUMNS)
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .whereRaw(`${DATE_IN_GEORGIA} = ${TODAY_IN_GEORGIA}`)
          .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc");
        const seenToday = new Set();
        todayJobs = todayJobs.filter((j) => {
          const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
          if (seenToday.has(key)) return false;
          seenToday.add(key);
          return true;
        });
        todayJobsCount = todayJobs.length;
      }

      // Form submission jobs (ვაკანსიები სადაც CV გარეშე მიგიღებენ) – jobs that accept form without CV
      const formSubRaw = await db("jobs")
        .select(...JOBS_LIST_COLUMNS)
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
        .whereRaw("(accept_form_submissions IS TRUE)")
        .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(50);
      const seenFormSub = new Set();
      formSubmissionJobs = formSubRaw.filter((j) => {
        const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
        if (seenFormSub.has(key)) return false;
        seenFormSub.add(key);
        return true;
      }).slice(0, 20);
      const formSubCountRow = await db("jobs")
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
        .whereRaw("(accept_form_submissions IS TRUE)")
        .count("* as total")
        .first();
      formSubmissionTotalCount = parseInt(formSubCountRow?.total || 0, 10);
    }

    // Top CV-fit jobs (ვაკანსიები სადაც შენი CV ზუსტად ერგება) – when user is logged in and has CV embedding
    if (!filtersActive && req.session?.user?.uid) {
      try {
        const userId = req.session.user.uid;
        let matches;
        const cached = cvFitCache.get(userId);
        if (cached && cached.expiresAt > Date.now()) {
          matches = cached.matches;
        } else {
          const { getTopJobsForUser } = require("./services/pineconeJobs");
          matches = await getTopJobsForUser(userId, 50, 0.4);
          cvFitCache.set(userId, { matches });
        }
        const jobIds = matches.map((m) => parseInt(m.id, 10)).filter((id) => !isNaN(id));
        if (jobIds.length > 0) {
          const jobsFromDb = await db("jobs")
            .whereIn("id", jobIds)
            .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
            .select(...JOBS_LIST_COLUMNS);
          const scoreMap = Object.fromEntries(matches.map((m) => [parseInt(m.id, 10), m.score]));
          const withScore = jobIds
            .map((id) => {
              const job = jobsFromDb.find((j) => j.id === id);
              if (!job) return null;
              return { ...job, score: scoreMap[id] ?? 0 };
            })
            .filter(Boolean);
          // Prioritize premium/premiumPlus first, then prioritize, then rest by score
          const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || j.prioritize === "true" || ["premium", "premiumPlus"].includes(j.job_premium_status);
          const sortRank = (j) => {
            if (["premiumPlus", "premium"].includes(j.job_premium_status) && isBoosted(j)) return j.job_premium_status === "premiumPlus" ? 0 : 1;
            if (j.job_premium_status === "premiumPlus") return 2;
            if (j.job_premium_status === "premium") return 3;
            if (j.prioritize) return 4;
            return 5;
          };
          topCvFitJobs = withScore.sort((a, b) => {
            const ra = sortRank(a);
            const rb = sortRank(b);
            if (ra !== rb) return ra - rb;
            return (b.score ?? 0) - (a.score ?? 0);
          });
          topCvFitTotalCount = topCvFitJobs.length;
        }
      } catch (e) {
        console.error("topCvFitJobs fetch error:", e?.message);
      }
    }
    }

    let query = db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
    let countQuery = db("jobs")
      .count("* as total")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
    // Exclude today's jobs from main listing (ყველა ვაკანსია) – unless filters/search active (today section is hidden)
    if (!filtersActive) {
      query.whereRaw(`${DATE_IN_GEORGIA} < ${TODAY_IN_GEORGIA}`);
      countQuery.whereRaw(`${DATE_IN_GEORGIA} < ${TODAY_IN_GEORGIA}`);
    }

    // Apply same filters to both queries
    if (company) {
      query.where("companyName", company);
      countQuery.where("companyName", company);
    }
    if (category) {
      const cats = Array.isArray(category) ? category : [category];
      query.whereIn("category_id", cats);
      countQuery.whereIn("category_id", cats);
    }
    if (job_experience) {
      const exp = Array.isArray(job_experience)
        ? job_experience
        : [job_experience];
      query.whereIn("job_experience", exp);
      countQuery.whereIn("job_experience", exp);
    }
    if (min_salary) {
      const min = parseInt(min_salary, 10);
      if (!isNaN(min)) {
        // Use precomputed numeric minimum salary for filtering
        query.where("jobSalary_min", ">=", min);
        countQuery.where("jobSalary_min", ">=", min);
      }
    }
    if (job_type) {
      const types = Array.isArray(job_type) ? job_type : [job_type];
      query.whereIn("job_type", types);
      countQuery.whereIn("job_type", types);
    }
    if (job_city) {
      const cities = Array.isArray(job_city) ? job_city : [job_city];
      query.whereIn("job_city", cities);
      countQuery.whereIn("job_city", cities);
    }
    if (hasSalary === "true") {
      query.whereNotNull("jobSalary");
      countQuery.whereNotNull("jobSalary");
    }
    if (job_premium_status) {
      const premium = Array.isArray(job_premium_status)
        ? job_premium_status
        : [job_premium_status];
      query.whereIn("job_premium_status", premium);
      countQuery.whereIn("job_premium_status", premium);
    }

    // Search: job name, company name, or job description (case-insensitive)
    if (searchQuery && typeof searchQuery === "string" && searchQuery.trim()) {
      const term =
        "%" +
        searchQuery.trim().replace(/%/g, "\\%").replace(/_/g, "\\_") +
        "%";
      query.andWhereRaw(
        '("jobName" ilike ? OR "companyName" ilike ? OR COALESCE("jobDescription", \'\') ilike ?)',
        [term, term, term]
      );
      countQuery.andWhereRaw(
        '("jobName" ilike ? OR "companyName" ilike ? OR COALESCE("jobDescription", \'\') ilike ?)',
        [term, term, term]
      );
    }

    // Get total count
    const [{ total }] = await countQuery;
    const totalPages = Math.ceil(total / Number(limit));

    const PREMIUM_PRIORITIZE_ORDER = `CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`;
    let jobs = await query
      .orderByRaw(PREMIUM_PRIORITIZE_ORDER)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(fetchLimit)
      .offset(offset);

    // Deduplicate: same job name + company = keep first (by our sort order)
    const seenKey = new Set();
    jobs = jobs.filter((j) => {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });

    const baseUrl = "https://samushao.ge";
    const canonical = baseUrl + (pageNum === 1 ? "/" : "/?page=" + pageNum);
    res.render("index", {
      jobs,
      recommendedJobs,
      topSalaryJobs,
      topSalaryTotalCount,
      topPopularJobs,
      topPopularTotalCount,
      topCvFitJobs: topCvFitJobs || [],
      topCvFitTotalCount: topCvFitTotalCount || 0,
      formSubmissionJobs: formSubmissionJobs || [],
      formSubmissionTotalCount: formSubmissionTotalCount || 0,
      todayJobs,
      todayJobsCount,
      currentPage: pageNum,
      totalPages,
      totalJobs: total,
      filters: req.query,
      filtersActive,
      paginationBase: "/",
      deferBelowFold: deferBelowFold || false,
      slugify,
      seo: {
        title: "ვაკანსიები | Samushao.ge",
        description:
          "ვაკანსიები საქართველოში. იპოვე სამუშაო და გაგზავნე CV პირდაპირ კომპანიებში.",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
        canonical,
      },
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Most popular jobs page – 20 most viewed; slots 2-3 = premium first, then prioritized
app.get("/kvelaze-motkhovnadi-vakansiebi", async (req, res) => {
  try {
    const topLimit = 20;
    const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || ["premium", "premiumPlus"].includes(j.job_premium_status);
    let jobsRaw = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .orderByRaw("COALESCE(view_count, 0) DESC")
      .limit(50);
    const prioritizedWithViews = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .where((qb) => qb.where("prioritize", true).orWhereIn("job_premium_status", ["premium", "premiumPlus"]))
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
      .orderByRaw("COALESCE(view_count, 0) DESC")
      .limit(2);
    const seenKey = new Set();
    jobsRaw = jobsRaw.filter((j) => {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });
    const dedupePrioritized = [];
    const seenP = new Set();
    for (const j of prioritizedWithViews) {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (!seenP.has(key)) {
        seenP.add(key);
        dedupePrioritized.push(j);
      }
    }
    const nonBoosted = jobsRaw.filter((j) => !isBoosted(j));
    const slot1 = (nonBoosted[0] || jobsRaw[0]);
    const prioritizedFor23 = dedupePrioritized.slice(0, 2);
    const usedIds = new Set([slot1?.id, ...prioritizedFor23.map((j) => j.id)].filter(Boolean));
    const restByViews = jobsRaw.filter((j) => !usedIds.has(j.id));
    const jobs = [slot1, ...prioritizedFor23, ...restByViews].filter(Boolean).slice(0, topLimit);

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: 0,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: 1,
      totalPages: 1,
      totalJobs: jobs.length,
      filters: {},
      filtersActive: false,
      pageType: "top-views",
      paginationBase: "/kvelaze-motkhovnadi-vakansiebi",
      slugify,
      seo: {
        title: "ყველაზე ნახვადი ვაკანსიები | Samushao.ge",
        description: "ყველაზე ნახვადი ვაკანსიები",
        canonical: "https://samushao.ge/kvelaze-motkhovnadi-vakansiebi",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
      },
    });
  } catch (err) {
    console.error("kvelaze-motkhovnadi-vakansiebi error:", err);
    res.status(500).send(err.message);
  }
});

// Highest paid jobs page – shows only top 20 (same as slider)
app.get("/kvelaze-magalanazgaurebadi-vakansiebi", async (req, res) => {
  try {
    const topLimit = 20;

    // Top salary: slot 1 = highest paid non-boosted; slots 2-3 = premium first, then prioritized
    const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || ["premium", "premiumPlus"].includes(j.job_premium_status);
    let jobsRaw = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .whereNotNull("jobSalary_min")
      .orderBy("jobSalary_min", "desc")
      .limit(50);
    const prioritizedWithSalary = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .where((qb) => qb.where("prioritize", true).orWhereIn("job_premium_status", ["premium", "premiumPlus"]))
      .whereNotNull("jobSalary_min")
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
      .orderBy("jobSalary_min", "desc")
      .limit(2);
    const seenKey = new Set();
    jobsRaw = jobsRaw.filter((j) => {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });
    const dedupePrioritized = [];
    const seenP = new Set();
    for (const j of prioritizedWithSalary) {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (!seenP.has(key)) {
        seenP.add(key);
        dedupePrioritized.push(j);
      }
    }
    const nonBoosted = jobsRaw.filter((j) => !isBoosted(j));
    const slot1 = (nonBoosted[0] || jobsRaw[0]);
    const prioritizedFor23 = dedupePrioritized.slice(0, 2);
    const usedIds = new Set([slot1?.id, ...prioritizedFor23.map((j) => j.id)].filter(Boolean));
    const restBySalary = jobsRaw.filter((j) => !usedIds.has(j.id));
    const jobs = [slot1, ...prioritizedFor23, ...restBySalary].filter(Boolean).slice(0, topLimit);

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: jobs.length,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: 1,
      totalPages: 1,
      totalJobs: jobs.length,
      filters: {},
      filtersActive: false,
      pageType: "top-salary",
      paginationBase: "/kvelaze-magalanazgaurebadi-vakansiebi",
      slugify,
      seo: {
        title: "ყველაზე მაღალანაზღაურებადი ვაკანსიები | Samushao.ge",
        description:
          "ყველაზე მაღალანაზღაურებადი ვაკანსიები",
        canonical: "https://samushao.ge/kvelaze-magalanazgaurebadi-vakansiebi",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
      },
    });
  } catch (err) {
    console.error("kvelaze-magalanazgaurebadi-vakansiebi error:", err);
    res.status(500).send(err.message);
  }
});

// Today's jobs page (დღევანდელი ვაკანსიები)
app.get("/dgevandeli-vakansiebi", async (req, res) => {
  try {
    let jobs = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .whereRaw(`${DATE_IN_GEORGIA} = ${TODAY_IN_GEORGIA}`)
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc");

    const seenKey = new Set();
    jobs = jobs.filter((j) => {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: 0,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: 1,
      totalPages: 1,
      totalJobs: jobs.length,
      filters: {},
      filtersActive: false,
      pageType: "today",
      paginationBase: "/dgevandeli-vakansiebi",
      slugify,
      seo: {
        title: "დღევანდელი ვაკანსიები | Samushao.ge",
        description:
          "დღევანდელი ვაკანსიები. იპოვე სამუშაო და გაგზავნე CV.",
        canonical: "https://samushao.ge/dgevandeli-vakansiebi",
      },
    });
  } catch (err) {
    console.error("dgevandeli-vakansiebi error:", err);
    res.status(500).send(err.message);
  }
});

// Recommended jobs page (შენთვის რეკომენდებული ვაკანსიები)
app.get("/rekomendebuli-vakansiebi", async (req, res) => {
  try {
    const rec = await getRecommendedJobs(db, req.visitorId, {
      limit: 100,
      offset: 0,
      userUid: req.session?.user?.uid,
    });
    const jobs = rec.jobs || [];

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: 0,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: 1,
      totalPages: 1,
      totalJobs: jobs.length,
      filters: {},
      filtersActive: false,
      pageType: "recommended",
      paginationBase: "/rekomendebuli-vakansiebi",
      slugify,
      seo: {
        title: "მსგავს ვაკანსიებს ხშირად სტუმრობ | Samushao.ge",
        description:
          "ვაკანსიები რომლებიც შეესაბამება იმას რაც უკვე დაინტერესებული იყავი.",
        canonical: "https://samushao.ge/rekomendebuli-vakansiebi",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
      },
    });
  } catch (err) {
    console.error("rekomendebuli-vakansiebi error:", err);
    res.status(500).send(err.message);
  }
});

// Jobs that accept form without CV (ვაკანსიები სადაც CV გარეშე მიგიღებენ) – infinite scroll
app.get("/vakansiebi-cv-gareshe", async (req, res) => {
  try {
    const limit = 20;
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const isAppendRequest = req.query.append === "1";
    if (isAppendRequest) {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      res.set("Pragma", "no-cache");
    }

    const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || ["premium", "premiumPlus"].includes(j.job_premium_status);
    let jobsRaw = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .whereRaw("(accept_form_submissions IS TRUE)")
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc");
    const prioritizedFormSub = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .whereRaw("(accept_form_submissions IS TRUE)")
      .where((qb) => qb.where("prioritize", true).orWhereIn("job_premium_status", ["premium", "premiumPlus"]))
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
      .orderBy("created_at", "desc")
      .limit(2);
    const seenKey = new Set();
    jobsRaw = jobsRaw.filter((j) => {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });
    const dedupePrioritized = [];
    const seenP = new Set();
    for (const j of prioritizedFormSub) {
      const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
      if (!seenP.has(key)) {
        seenP.add(key);
        dedupePrioritized.push(j);
      }
    }
    const nonBoosted = jobsRaw.filter((j) => !isBoosted(j));
    const slot1 = (nonBoosted[0] || jobsRaw[0]);
    const prioritizedFor23 = dedupePrioritized.slice(0, 2);
    const usedIds = new Set([slot1?.id, ...prioritizedFor23.map((j) => j.id)].filter(Boolean));
    const rest = jobsRaw.filter((j) => !usedIds.has(j.id));
    const allJobs = [slot1, ...prioritizedFor23, ...rest].filter(Boolean);

    const totalJobs = allJobs.length;
    const totalPages = Math.max(1, Math.ceil(totalJobs / limit));
    const offset = isAppendRequest ? (pageNum - 1) * limit : 0;
    const fetchLimit = isAppendRequest ? limit : pageNum * limit;
    const jobs = allJobs.slice(offset, offset + fetchLimit);

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: 0,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      topCvFitJobs: [],
      topCvFitTotalCount: 0,
      formSubmissionJobs: [],
      formSubmissionTotalCount: totalJobs,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: pageNum,
      totalPages,
      totalJobs,
      filters: {},
      filtersActive: false,
      pageType: "form-submission",
      paginationBase: "/vakansiebi-cv-gareshe",
      slugify,
      seo: {
        title: "ვაკანსიები სადაც CV გარეშე მიგიღებენ | Samushao.ge",
        description: "ვაკანსიები რომლებშიც განაცხადის ფორმის შევსება შეგიძლიათ CV-ის გაგზავნის გარეშე.",
        canonical: "https://samushao.ge/vakansiebi-cv-gareshe",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
      },
    });
  } catch (err) {
    console.error("vakansiebi-cv-gareshe error:", err);
    res.status(500).send(err.message);
  }
});

// Jobs where your CV fits (ვაკანსიები სადაც შენი CV ზუსტად ერგება) – requires login, uses Pinecone CV matching
app.get("/vakansiebi-shentvis", async (req, res) => {
  try {
    let jobs = [];
    const userUid = req.session?.user?.uid;
    if (userUid) {
      try {
        let matches;
        const cached = cvFitCache.get(userUid);
        if (cached && cached.expiresAt > Date.now()) {
          matches = cached.matches;
        } else {
          const { getTopJobsForUser } = require("./services/pineconeJobs");
          matches = await getTopJobsForUser(userUid, 50, 0.4);
          cvFitCache.set(userUid, { matches });
        }
        const jobIds = matches.map((m) => parseInt(m.id, 10)).filter((id) => !isNaN(id));
        if (jobIds.length > 0) {
          const jobsFromDb = await db("jobs")
            .whereIn("id", jobIds)
            .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
            .select(...JOBS_LIST_COLUMNS);
          const scoreMap = Object.fromEntries(matches.map((m) => [parseInt(m.id, 10), m.score]));
          const withScore = jobIds
            .map((id) => {
              const job = jobsFromDb.find((j) => j.id === id);
              if (!job) return null;
              return { ...job, score: scoreMap[id] ?? 0 };
            })
            .filter(Boolean);
          const isBoosted = (j) => j.prioritize === true || j.prioritize === 1 || j.prioritize === "true" || ["premium", "premiumPlus"].includes(j.job_premium_status);
          const sortRank = (j) => {
            if (["premiumPlus", "premium"].includes(j.job_premium_status) && isBoosted(j)) return j.job_premium_status === "premiumPlus" ? 0 : 1;
            if (j.job_premium_status === "premiumPlus") return 2;
            if (j.job_premium_status === "premium") return 3;
            if (j.prioritize) return 4;
            return 5;
          };
          jobs = withScore.sort((a, b) => {
            const ra = sortRank(a);
            const rb = sortRank(b);
            if (ra !== rb) return ra - rb;
            return (b.score ?? 0) - (a.score ?? 0);
          });
        }
      } catch (e) {
        console.error("vakansiebi-shentvis fetch error:", e?.message);
      }
    }

    res.render("index", {
      jobs,
      recommendedJobs: [],
      topSalaryJobs: [],
      topSalaryTotalCount: 0,
      topPopularJobs: [],
      topPopularTotalCount: 0,
      topCvFitJobs: [],
      topCvFitTotalCount: jobs.length,
      todayJobs: [],
      todayJobsCount: 0,
      currentPage: 1,
      totalPages: 1,
      totalJobs: jobs.length,
      filters: {},
      filtersActive: false,
      pageType: "top-cv-fit",
      paginationBase: "/vakansiebi-shentvis",
      slugify,
      seo: {
        title: "ვაკანსიები სადაც შენი CV ერგება | Samushao.ge",
        description: "ვაკანსიები რომლებიც ზუსტად შეესაბამება შენი CV-ს.",
        canonical: "https://samushao.ge/vakansiebi-shentvis",
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
      },
    });
  } catch (err) {
    console.error("vakansiebi-shentvis error:", err);
    res.status(500).send(err.message);
  }
});

// Privacy policy page
app.get("/privacy-policy", (req, res) => {
  res.render("privacy-policy", {
    seo: {
      title: "მონაცემთა დაცვის პოლიტიკა | Samushao.ge",
      description: "Samushao.ge მონაცემთა დაცვის პოლიტიკა.",
      canonical: "https://samushao.ge/privacy-policy",
    },
  });
});

// Terms of use page
app.get("/terms-of-use", (req, res) => {
  res.render("terms-of-use", {
    seo: {
      title: "გამოყენების პირობები | Samushao.ge",
      description: "Samushao.ge გამოყენების პირობები.",
      canonical: "https://samushao.ge/terms-of-use",
    },
  });
});

// Test route to verify Sentry (remove in production if desired)
app.get("/debug-sentry", function mainHandler(req, res) {
  Sentry.captureException(new Error("My first Sentry error!"));
  throw new Error("My first Sentry error!");
});

// Pricing page
app.get("/pricing", (req, res) => {
  res.render("pricing", {
    seo: {
      title: "ფასები | Samushao.ge",
      description:
        "Samushao.ge ფასები და პაკეტები ვაკანსიების გამოქვეყნებისთვის.",
      canonical: "https://samushao.ge/pricing",
    },
  });
});

// My applications (sent CVs) - user type only
app.get("/my-applications", async (req, res) => {
  if (!req.session?.user) {
    return res.redirect("/");
  }
  if (req.session.user.user_type !== "user") {
    return res.redirect("/");
  }
  try {
    const applications = await db("job_applications")
      .where("user_id", req.session.user.uid)
      .orderBy("created_at", "desc");
    const jobIds = applications.map((a) => a.job_id);
    const jobs =
      jobIds.length === 0
        ? []
        : await db("jobs")
            .whereIn("id", jobIds)
            .where("job_status", "approved");
    // Preserve order by application date (newest first)
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const orderedJobs = jobIds.map((id) => jobById.get(id)).filter(Boolean);

    // Load user's automatic CV sending preference (default: true)
    let wantsCvAuto = true;
    try {
      const userRow = await db("users")
        .where("user_uid", req.session.user.uid)
        .first();
      if (userRow && (userRow.wants_cv_to_be_sent === false || userRow.wants_cv_to_be_sent === 0)) {
        wantsCvAuto = false;
      } else {
        wantsCvAuto = true;
      }
    } catch (prefErr) {
      console.error("Failed to load user CV auto-send preference:", prefErr);
    }

    res.render("sent-cvs", {
      jobs: orderedJobs,
      wantsCvAuto,
      slugify,
      seo: {
        title: "გაგზავნილი CV-ები | Samushao.ge",
        description: "ჩემი გაგზავნილი CV-ები.",
        canonical: "https://samushao.ge/my-applications",
      },
    });
  } catch (err) {
    console.error("my-applications error:", err);
    res.status(500).send(err.message);
  }
});

// My CV page – view, delete, upload
app.get("/my-cv", async (req, res) => {
  if (!req.session?.user) {
    return res.redirect("/");
  }
  if (req.session.user.user_type !== "user") {
    return res.redirect("/");
  }
  try {
    const resume = await db("resumes")
      .where("user_id", req.session.user.uid)
      .orderBy("updated_at", "desc")
      .first();
    res.render("my-cv", {
      resume: resume || null,
      slugify,
      seo: {
        title: "ჩემი CV | Samushao.ge",
        description: "ნახეთ, განაახლეთ ან წაშალეთ თქვენი CV.",
        canonical: "https://samushao.ge/my-cv",
      },
    });
  } catch (err) {
    console.error("my-cv error:", err);
    res.status(500).send(err.message);
  }
});

// Proxy CV file for inline display (iframe/embed fail with Cloudinary attachment URLs)
app.get("/my-cv/preview", async (req, res) => {
  if (!req.session?.user || req.session.user.user_type !== "user") {
    return res.status(403).send("Forbidden");
  }
  try {
    const resume = await db("resumes")
      .where("user_id", req.session.user.uid)
      .orderBy("updated_at", "desc")
      .first();
    if (!resume?.file_url) {
      return res.status(404).send("CV not found");
    }
    const url = resume.file_url;
    const ext = (resume.file_name || "").toLowerCase().match(/\.(pdf|doc|docx|jpg|jpeg|png|gif|webp)(\?|$)/)?.[1] || "pdf";
    const mime = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }[ext] || "application/octet-stream";
    const fetchRes = await fetch(url);
    if (!fetchRes.ok) {
      return res.status(502).send("Failed to fetch CV");
    }
    const buf = Buffer.from(await fetchRes.arrayBuffer());
    if (ext === "pdf" && buf.length >= 5 && buf.subarray(0, 5).toString() !== "%PDF-") {
      console.warn("[my-cv/preview] Cloudinary returned non-PDF for PDF file, first bytes:", buf.subarray(0, 50).toString("utf8"));
      return res.status(502).send("Invalid CV file");
    }
    res.set("Content-Type", mime);
    res.set("Content-Disposition", "inline");
    res.send(buf);
  } catch (err) {
    console.error("my-cv preview error:", err);
    res.status(500).send("Error loading CV");
  }
});

app.post("/my-cv/delete", async (req, res) => {
  if (!req.session?.user || req.session.user.user_type !== "user") {
    return res.redirect("/");
  }
  const userId = req.session.user.uid;
  try {
    await db("resumes").where("user_id", userId).del();
    const { deleteCandidate } = require("./services/pineconeCandidates");
    await deleteCandidate(userId).catch((err) => console.warn("[Pinecone] Failed to delete candidate", userId, err.message));
    cvFitCache.invalidate(userId);
  } catch (err) {
    console.error("my-cv delete error:", err);
  }
  return res.redirect("/my-cv");
});

// Toggle automatic CV sending preference for current user
app.post("/my-applications/auto-send-toggle", async (req, res) => {
  if (!req.session?.user || req.session.user.user_type !== "user") {
    return res.redirect("/");
  }
  try {
    const current = await db("users")
      .where("user_uid", req.session.user.uid)
      .first();
    const currentValue =
      current && (current.wants_cv_to_be_sent === true || current.wants_cv_to_be_sent === 1);
    const nextValue = !currentValue;
    await db("users")
      .where("user_uid", req.session.user.uid)
      .update({
        wants_cv_to_be_sent: nextValue,
        consent_updated_at: db.fn.now(),
      });
    return res.redirect("/my-applications");
  } catch (err) {
    console.error("auto-send-toggle error:", err);
    return res.redirect("/my-applications");
  }
});

// get vacancy inner page
app.get("/vakansia/:slug", async (req, res) => {
  try {
    runPremiumExpiryCleanup().catch(() => {});
    runExpiredJobsPineconeCleanup().catch(() => {});

    const slug = req.params.slug;
    const jobIdRaw = extractIdFromSlug(slug);
    const jobId = jobIdRaw ? parseInt(jobIdRaw, 10) : null;

    if (!jobId || isNaN(jobId)) {
      return res.status(404).render("404", { message: "Job not found" });
    }

    const job = await db("jobs")
      .where({ id: jobId, job_status: "approved" })
      .first();

    if (!job) {
      return res.status(404).render("404", { message: "Job not found" });
    }

    // Prevent caching so every view hits the server and gets counted
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.set("Pragma", "no-cache");

    // Generate correct slug and redirect if URL doesn't match (always to clean URL for SEO)
    const correctSlug = slugify(job.jobName) + "-" + job.id;
    if (slug !== correctSlug) {
      return res.redirect(301, `/vakansia/${correctSlug}`);
    }

    // Redirect ?from=recommended etc. to clean URL – prevents "Duplicate, Google chose different canonical"
    if (Object.keys(req.query).length > 0) {
      return res.redirect(301, `/vakansia/${correctSlug}`);
    }

    // Fire-and-forget: view_count and visitor tracking (don't block response)
    db.raw("UPDATE jobs SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?", [jobId]).catch((e) =>
      console.error("view_count increment error:", e?.message)
    );
    if (req.visitorId) {
      const catPromise = job.category_id
        ? db("categories").where("id", job.category_id).select("name").first()
        : Promise.resolve(null);
      catPromise.then((cat) =>
        db("visitor_job_clicks").insert({
          visitor_id: req.visitorId,
          job_id: jobId,
          job_salary: job.jobSalary || null,
          job_title: job.jobName || null,
          category_id: job.category_id || null,
          job_category_name: (cat && cat.name) || null,
          job_city: job.job_city || null,
          job_experience: job.job_experience || null,
          job_type: job.job_type || null,
          from_recommended: req.query.from === "recommended",
        })
      ).catch((e) => console.error("visitor_job_clicks insert error:", e?.message));
    }

    // job_applications, job_form_submissions (related jobs load on 60% scroll via /api/jobs/:id/related)
    const applicationPromise =
      req.session?.user?.uid
        ? db("job_applications")
            .where({ user_id: req.session.user.uid, job_id: jobId })
            .first()
        : Promise.resolve(null);

    const formSubmissionPromise =
      parseJobIdsFromCookie(req).has(jobId)
        ? Promise.resolve(null)
        : req.session?.user?.uid
          ? db("job_form_submissions").where("job_id", jobId).where("user_id", req.session.user.uid).first()
          : req.visitorId
            ? db("job_form_submissions").where("job_id", jobId).where("visitor_id", req.visitorId).first()
            : Promise.resolve(null);

    const [application, formSubmission] = await Promise.all([
      applicationPromise,
      formSubmissionPromise,
    ]);

    const isExpired = job.expires_at && new Date(job.expires_at) <= new Date();
    const userAlreadyApplied = !!application;
    const userAlreadySubmittedForm = !!formSubmission;

    const jobDescription =
      job.job_description && job.job_description.length > 0
        ? job.job_description.substring(0, 155)
        : job.jobName + " at " + job.companyName;
    const jobCanonical =
      "https://samushao.ge/vakansia/" + slugify(job.jobName) + "-" + job.id;
    const acceptFormSubmissions = job.accept_form_submissions === true || job.accept_form_submissions === 1;
    const userAlreadyAppliedOrSubmitted = userAlreadyApplied || userAlreadySubmittedForm;
    const isHelio = job.isHelio === true || job.isHelio === 1 || job.is_helio === true || job.is_helio === 1;
    const helioUrl = (job.helio_url || job.helioUrl || "").toString().trim() || null;
    res.render("job-detail", {
      job: { ...job, accept_form_submissions: acceptFormSubmissions, isHelio: !!isHelio, helio_url: helioUrl },
      acceptFormSubmissions,
      relatedJobs: [], // loaded on 60% scroll via /api/jobs/:id/related
      slugify,
      userAlreadyApplied,
      userAlreadySubmittedForm,
      userAlreadyAppliedOrSubmitted,
      isExpired,
      seo: {
        title: job.jobName + " | Samushao.ge",
        description: "vakansia - " + jobDescription,
        ogImage:
          "https://res.cloudinary.com/dd7gz0aqv/image/upload/v1743605652/export_l1wpwr.png",
        canonical: jobCanonical,
      },
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/api/jobs/:id/related", async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    if (!jobId || isNaN(jobId)) return res.status(400).json({ error: "Invalid job ID" });
    const job = await db("jobs").where({ id: jobId, job_status: "approved" }).first();
    if (!job) return res.status(404).json({ error: "Job not found" });

    const relatedJobsRaw = await db("jobs")
      .select(...JOBS_LIST_COLUMNS)
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .where((qb) => {
        qb.where("category_id", job.category_id)
          .orWhere("prioritize", true)
          .orWhereIn("job_premium_status", ["premium", "premiumPlus"]);
      })
      .whereNot("id", jobId)
      .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 ELSE 5 END`)
      .orderByRaw("(CASE WHEN category_id = ? THEN 1 ELSE 0 END) DESC", [job.category_id])
      .orderBy("created_at", "desc")
      .limit(10);

    const isPremium = (j) => ["premium", "premiumPlus"].includes(j.job_premium_status);
    const premiumIdx = relatedJobsRaw.findIndex((j) => isPremium(j));
    let relatedJobs;
    if (relatedJobsRaw.length >= 2 && premiumIdx > 1) {
      const [first, , ...rest] = relatedJobsRaw;
      const premium = relatedJobsRaw[premiumIdx];
      const restWithoutPremium = relatedJobsRaw.filter((_, i) => i !== 0 && i !== premiumIdx);
      relatedJobs = [first, premium, ...restWithoutPremium].slice(0, 5);
    } else {
      relatedJobs = relatedJobsRaw.slice(0, 5);
    }

    const cards = [];
    for (const j of relatedJobs) {
      const html = await new Promise((resolve, reject) => {
        res.app.render("partials/jobItemCompact", { job: j, slugify, inSlider: true }, (err, str) => {
          if (err) reject(err);
          else resolve(str);
        });
      });
      const isPrem = j.job_premium_status === "premium" || j.job_premium_status === "premiumPlus";
      cards.push({
        html,
        premium: isPrem,
      });
    }
    res.json({ cards });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

cloudinary.config({
  cloud_name: "dd7gz0aqv",
  api_key: "345132216437496",
  api_secret: "gRBZZuGtsxALJlZ7sxh8SCwgTVw",
});

// FB promo enlist: record click, set cookie, redirect to Facebook
const FB_GROUP_URL = "https://www.facebook.com/groups/964592739202329";
app.get("/api/enlist-fb", async (req, res) => {
  try {
    if (!hasEnlistedFbCookie(req)) {
      await db("enlisted_in_fb").insert({
        visitor_id: req.visitorId || null,
        user_id: req.session?.user?.uid || null,
        action: "enlist",
      });
      res.cookie(ENLISTED_FB_COOKIE, "1", {
        maxAge: 10 * 365 * 24 * 60 * 60,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      });
    }
  } catch (err) {
    console.error("enlist-fb error:", err);
  }
  res.redirect(302, FB_GROUP_URL);
});
app.get("/api/dismiss-fb-promo", async (req, res) => {
  try {
    if (!hasEnlistedFbCookie(req)) {
      await db("enlisted_in_fb").insert({
        visitor_id: req.visitorId || null,
        user_id: req.session?.user?.uid || null,
        action: "dismiss",
      });
      res.cookie(ENLISTED_FB_COOKIE, "1", {
        maxAge: 10 * 365 * 24 * 60 * 60,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      });
    }
  } catch (err) {
    console.error("dismiss-fb-promo error:", err);
  }
  res.status(204).end();
});
app.get("/api/enlist-fb/count", async (req, res) => {
  try {
    const [{ count }] = await db("enlisted_in_fb")
      .whereRaw("(action IS NULL OR action = ?)", ["enlist"])
      .count("id as count");
    res.json({ count: parseInt(count, 10) || 0 });
  } catch (err) {
    console.error("enlist-fb count error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Filter counts (contextual: when category=2 active, other counts reflect jobs in that category)
// Cached server-side; invalidated only when new jobs are inserted.
const { getFilterCountsKey, get: getFilterCounts, set: setFilterCounts } = require("./services/filterCountsCache");

app.get("/api/filter-counts", async (req, res) => {
  try {
    const { category, min_salary, job_experience, job_type, job_city, q } = req.query;
    const cacheKey = getFilterCountsKey({ category, min_salary, job_experience, job_type, job_city, q });
    const cached = getFilterCounts(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    const hasAnyFilter =
      (category && category.length > 0) ||
      (min_salary && min_salary.length > 0) ||
      (job_experience && job_experience.length > 0) ||
      (job_type && job_type.length > 0) ||
      (job_city && job_city.length > 0) ||
      (q && typeof q === "string" && q.trim() !== "");

    const filterSearchTerm = (q && typeof q === "string" ? q.trim() : "") || "";
    const baseQuery = () => {
      let query = db("jobs")
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
      if (!hasAnyFilter) {
        query = query.whereRaw("(created_at AT TIME ZONE ?)::date < (NOW() AT TIME ZONE ?)::date", [TZ_GEORGIA, TZ_GEORGIA]);
      }
      return query;
    };

    const applyOtherFilters = (query, exclude) => {
      if (exclude !== "category" && category) {
        const raw = (Array.isArray(category) ? category : [category]).filter((c) => c != null && c !== "");
        const cats = raw.flatMap((c) => String(c).split(",").map((s) => s.trim())).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
        if (cats.length === 1) {
          query.where("category_id", cats[0]);
        } else if (cats.length > 1) {
          query.whereIn("category_id", cats);
        }
      }
      if (exclude !== "min_salary" && min_salary) {
        const val = Array.isArray(min_salary) ? min_salary[0] : min_salary;
        const min = parseInt(val, 10);
        if (!isNaN(min)) query.where("jobSalary_min", ">=", min);
      }
      if (exclude !== "job_experience" && job_experience) {
        const exp = (Array.isArray(job_experience) ? job_experience : [job_experience]).filter((e) => e != null && e !== "");
        if (exp.length > 0) query.whereIn("job_experience", exp);
      }
      if (exclude !== "job_type" && job_type) {
        const types = (Array.isArray(job_type) ? job_type : [job_type]).filter((t) => t != null && t !== "");
        if (types.length > 0) query.whereIn("job_type", types);
      }
      if (exclude !== "job_city" && job_city) {
        const cities = (Array.isArray(job_city) ? job_city : [job_city]).filter((c) => c != null && c !== "");
        if (cities.length > 0) query.whereIn("job_city", cities);
      }
      if (exclude !== "q" && filterSearchTerm) {
        const term =
          "%" + filterSearchTerm.replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
        query.andWhereRaw(
          '("jobName" ilike ? OR "companyName" ilike ? OR COALESCE("jobDescription", \'\') ilike ?)',
          [term, term, term]
        );
      }
      return query;
    };

    const [categoryRows, salary1000, salary2000, salary3000, salary4000, salary5000, salary6000, expRows, typeRows, cityRows] =
      await Promise.all([
        applyOtherFilters(baseQuery().clone(), "category")
          .select("category_id")
          .count("* as c")
          .groupBy("category_id"),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 1000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 2000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 3000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 4000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 5000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone().where("jobSalary_min", ">=", 6000), "min_salary")
          .count("* as c")
          .first(),
        applyOtherFilters(baseQuery().clone(), "job_experience")
          .select("job_experience")
          .count("* as c")
          .groupBy("job_experience"),
        applyOtherFilters(baseQuery().clone(), "job_type")
          .select("job_type")
          .count("* as c")
          .groupBy("job_type"),
        applyOtherFilters(baseQuery().clone(), "job_city")
          .whereIn("job_city", ["თბილისი", "ქუთაისი", "ბათუმი", "ზუგდიდი"])
          .select("job_city")
          .count("* as c")
          .groupBy("job_city"),
      ]);

    const categoryCounts = {};
    (categoryRows || []).forEach((r) => {
      categoryCounts[String(r.category_id)] = parseInt(r.c, 10) || 0;
    });

    const salaryCounts = {
      "1000": parseInt(salary1000?.c, 10) || 0,
      "2000": parseInt(salary2000?.c, 10) || 0,
      "3000": parseInt(salary3000?.c, 10) || 0,
      "4000": parseInt(salary4000?.c, 10) || 0,
      "5000": parseInt(salary5000?.c, 10) || 0,
      "6000": parseInt(salary6000?.c, 10) || 0,
    };

    const experienceCounts = {};
    (expRows || []).forEach((r) => {
      if (r.job_experience) experienceCounts[String(r.job_experience)] = parseInt(r.c, 10) || 0;
    });

    const jobTypeCounts = {};
    (typeRows || []).forEach((r) => {
      if (r.job_type) jobTypeCounts[String(r.job_type)] = parseInt(r.c, 10) || 0;
    });

    const cityCounts = {};
    (cityRows || []).forEach((r) => {
      if (r.job_city) cityCounts[String(r.job_city)] = parseInt(r.c, 10) || 0;
    });

    const result = {
      category: categoryCounts,
      min_salary: salaryCounts,
      job_experience: experienceCounts,
      job_type: jobTypeCounts,
      job_city: cityCounts,
    };
    setFilterCounts(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("filter-counts error:", err.message, "query params:", req.query);
    res.status(500).json({ error: err.message });
  }
});

// Lazy-loaded home sections (today's jobs, main jobs area) – used for below-fold content
app.get("/api/home/section", async (req, res) => {
  try {
    const { section } = req.query;
    if (!section || !["today", "main"].includes(section)) {
      return res.status(400).send("Missing or invalid section");
    }

    const {
      category,
      company,
      job_experience,
      job_type,
      job_city,
      page = 1,
      limit: limitParam = 5,
      hasSalary,
      job_premium_status,
      min_salary,
      q: searchQuery,
    } = req.query;

    const limit = Number(limitParam);
    const pageNum = Number(page);

    const filterParamKeys = [
      "category",
      "company",
      "job_experience",
      "job_type",
      "job_city",
      "hasSalary",
      "job_premium_status",
      "min_salary",
      "q",
    ];
    const filtersActive = filterParamKeys.some((key) => {
      const v = req.query[key];
      if (v === undefined || v === "") return false;
      return Array.isArray(v) ? v.length > 0 : true;
    });

    if (section === "today" && !filtersActive) {
      let todayJobs = await db("jobs")
        .select(...JOBS_LIST_COLUMNS)
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
        .whereRaw(`${DATE_IN_GEORGIA} = ${TODAY_IN_GEORGIA}`)
        .orderByRaw(`CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc");
      const seenToday = new Set();
      todayJobs = todayJobs.filter((j) => {
        const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
        if (seenToday.has(key)) return false;
        seenToday.add(key);
        return true;
      });
      const todayJobsCount = todayJobs.length;
      req.app.render(
        "partials/homeTodaySection",
        { todayJobs, todayJobsCount, slugify, filtersActive },
        (err, html) => {
          if (err) return res.status(500).send(err.message);
          res.type("text/html").send(html);
        }
      );
      return;
    }

    if (section === "main") {
      let query = db("jobs")
        .select(...JOBS_LIST_COLUMNS)
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
      let countQuery = db("jobs")
        .count("* as total")
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
      if (!filtersActive) {
        query.whereRaw(`${DATE_IN_GEORGIA} < ${TODAY_IN_GEORGIA}`);
        countQuery.whereRaw(`${DATE_IN_GEORGIA} < ${TODAY_IN_GEORGIA}`);
      }
      if (company) {
        query.where("companyName", company);
        countQuery.where("companyName", company);
      }
      if (category) {
        const cats = Array.isArray(category) ? category : [category];
        query.whereIn("category_id", cats);
        countQuery.whereIn("category_id", cats);
      }
      if (job_experience) {
        const exp = Array.isArray(job_experience) ? job_experience : [job_experience];
        query.whereIn("job_experience", exp);
        countQuery.whereIn("job_experience", exp);
      }
      if (min_salary) {
        const min = parseInt(min_salary, 10);
        if (!isNaN(min)) {
          query.where("jobSalary_min", ">=", min);
          countQuery.where("jobSalary_min", ">=", min);
        }
      }
      if (job_type) {
        const types = Array.isArray(job_type) ? job_type : [job_type];
        query.whereIn("job_type", types);
        countQuery.whereIn("job_type", types);
      }
      if (job_city) {
        const cities = Array.isArray(job_city) ? job_city : [job_city];
        query.whereIn("job_city", cities);
        countQuery.whereIn("job_city", cities);
      }
      if (hasSalary === "true") {
        query.whereNotNull("jobSalary");
        countQuery.whereNotNull("jobSalary");
      }
      if (job_premium_status) {
        const premium = Array.isArray(job_premium_status) ? job_premium_status : [job_premium_status];
        query.whereIn("job_premium_status", premium);
        countQuery.whereIn("job_premium_status", premium);
      }
      if (searchQuery && typeof searchQuery === "string" && searchQuery.trim()) {
        const term =
          "%" +
          searchQuery.trim().replace(/%/g, "\\%").replace(/_/g, "\\_") +
          "%";
        query.andWhereRaw(
          '("jobName" ilike ? OR "companyName" ilike ? OR COALESCE("jobDescription", \'\') ilike ?)',
          [term, term, term]
        );
        countQuery.andWhereRaw(
          '("jobName" ilike ? OR "companyName" ilike ? OR COALESCE("jobDescription", \'\') ilike ?)',
          [term, term, term]
        );
      }

      const [{ total }] = await countQuery;
      const totalPages = Math.ceil(total / limit);
      const PREMIUM_PRIORITIZE_ORDER = `CASE WHEN "job_premium_status" IN ('premium','premiumPlus') AND prioritize IS TRUE THEN CASE "job_premium_status" WHEN 'premiumPlus' THEN 0 WHEN 'premium' THEN 1 END WHEN "job_premium_status" = 'premiumPlus' THEN 2 WHEN "job_premium_status" = 'premium' THEN 3 WHEN prioritize IS TRUE THEN 4 WHEN "job_premium_status" = 'regular' THEN 5 ELSE 6 END`;
      let jobs = await query
        .orderByRaw(PREMIUM_PRIORITIZE_ORDER)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(pageNum * limit)
        .offset((pageNum - 1) * limit);

      const seenKey = new Set();
      jobs = jobs.filter((j) => {
        const key = String(j.jobName || "").trim() + "|" + String(j.companyName || "").trim();
        if (seenKey.has(key)) return false;
        seenKey.add(key);
        return true;
      });

      const paginationBase = "/";
      req.app.render(
        "partials/homeJobsArea",
        { jobs, currentPage: pageNum, totalPages, filtersActive, paginationBase, slugify },
        (err, html) => {
          if (err) return res.status(500).send(err.message);
          res.type("text/html").send(html);
        }
      );
      return;
    }

    res.status(400).send("Invalid section");
  } catch (err) {
    console.error("api/home/section error:", err);
    res.status(500).send(err.message);
  }
});

app.post("/api/auth/google", async (req, res) => {
  const { access_token } = req.body;

  try {
    // 1) Verify token with Google
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${access_token}` },
      },
    );

    const userInfo = await response.json();

    // 2) Create / update user in our own users service / API
    const USERS_SERVICE_URL =
      process.env.USERS_SERVICE_URL || "http://localhost:4001";

    const authResponse = await fetch(`${USERS_SERVICE_URL}/users/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_uid: userInfo.sub,
        user_name: userInfo.name,
        user_email: userInfo.email,
        user_type: "user",
      }),
    });

    const authData = await authResponse.json();

    req.session.user = {
      uid: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      user_type: (() => {
        const t = authData.user?.user_type ?? authData.user_type ?? "user";
        return t === "pending" || t == null || t === "" ? "user" : t;
      })(),
    };

    res.json({ success: true });
  } catch (error) {
    console.error("Auth error:", error);
    res.status(401).json({ success: false, error: error.message });
  }
});

// logout
app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
    }
    res.redirect("/");
  });
});
// jobs router
const jobsRouter = require("./routes/jobs");
app.get("/jobs/email-queue-status", async (req, res) => {
  const status = await jobsRouter.getEmailQueueStatus();
  res.json(status);
});
app.get("/jobs/email-queue-details", async (req, res) => {
  const details = await jobsRouter.getEmailQueueDetails();
  res.json(details);
});
app.get("/jobs/premium-low-cv-candidates", async (req, res) => {
  try {
    const data = await jobsRouter.getPremiumLowCvCandidatesData();
    res.json(data);
  } catch (err) {
    console.error("premium-low-cv-candidates error:", err);
    res.status(500).json({ error: err.message });
  }
});
app.post("/jobs/email-queue-kick", async (req, res) => {
  jobsRouter.kickEmailQueue();
  const status = await jobsRouter.getEmailQueueStatus();
  res.json({ ok: true, pending: status.pending });
});
app.post("/jobs/requeue-new-job-emails", async (req, res) => {
  try {
    const { jobIds } = req.body || {};
    const result = await jobsRouter.requeueJobsByIds(jobIds);
    res.json(result);
  } catch (err) {
    console.error("requeue-new-job-emails error:", err);
    res.status(500).json({ error: err.message });
  }
});
app.use("/jobs", jobsRouter);

// users router
const usersRouter = require("./routes/users");
app.use("/users", usersRouter);

// resumes router
const resumesRouter = require("./routes/resumes");
app.use("/resumes", resumesRouter);

// categories router
const categoriesRouter = require("./routes/categories");
app.use("/categories", categoriesRouter);

// company logos router
const companyLogosRouter = require("./routes/company_logos");
app.use("/upload-logo", companyLogosRouter);

// send cv router
const sendCvRouter = require("./routes/sendCv");
app.use("/send-cv", sendCvRouter);

// Job form submission (alternative to CV)
const jobFormSubmitRouter = require("./routes/jobFormSubmit")(db);
app.use("/submit-job-form", jobFormSubmitRouter);

// User without CV banner: submit form (saves to DB, sets cookie)
app.post("/api/user-without-cv", async (req, res) => {
  if (req.session?.user) {
    return res.status(400).json({ error: "Only for non-authenticated users" });
  }
  const { name, email, phone, short_description, categories, other_specify } = req.body || {};
  const trimmedName = (name || "").toString().trim();
  const trimmedPhone = (phone || "").toString().trim();
  if (!trimmedName) return res.status(400).json({ error: "სახელი აუცილებელია" });
  if (!trimmedPhone) return res.status(400).json({ error: "ტელეფონის ნომერი აუცილებელია" });
  const row = {
    name: trimmedName,
    email: (email || "").toString().trim() || null,
    phone: trimmedPhone,
    short_description: (short_description || "").toString().trim() || null,
    categories: Array.isArray(categories) ? categories.join(",") : (categories || "").toString().trim() || null,
    other_specify: (other_specify || "").toString().trim() || null,
  };
  try {
    const [inserted] = await db("user_without_cv").insert(row).returning("id");
    const id = inserted?.id ?? inserted;
    if (id && (process.env.PINECONE_API_KEY || "").trim()) {
      const { upsertUserWithoutCv } = require("./services/pineconeCandidates");
      const cats = Array.isArray(categories) ? categories : (row.categories || "").split(",").map((s) => s.trim()).filter(Boolean);
      upsertUserWithoutCv(id, {
        name: trimmedName,
        email: row.email || "",
        phone: trimmedPhone,
        short_description: row.short_description || "",
        categories: cats,
        other_specify: row.other_specify || "",
      }).catch((err) => console.error("[pinecone] user-without-cv upsert error:", err?.message));
    }
    res.cookie(NO_CV_BANNER_COOKIE, "1", {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("user-without-cv error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Admin: list candidates without CV (user_without_cv submissions)
app.get("/api/admin/user-without-cv", async (req, res) => {
  try {
    const rows = await db("user_without_cv")
      .select("*")
      .orderBy("created_at", "desc");
    res.json({ items: rows });
  } catch (err) {
    console.error("admin user-without-cv list error:", err);
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

// User without CV banner: dismiss (record in DB, set 30-day cookie – show again after month)
app.post("/api/user-without-cv/dismiss", async (req, res) => {
  if (req.session?.user) return res.json({ ok: true });
  try {
    if (req.visitorId) {
      await db("no_cv_banner_dismissals").insert({
        visitor_id: req.visitorId,
        dismissed_at: db.fn.now(),
      });
    }
  } catch (err) {
    console.error("no_cv_banner_dismissals insert error:", err?.message);
  }
  res.cookie(NO_CV_BANNER_COOKIE, "1", {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  res.json({ ok: true });
});

// Visitors API
app.post("/api/visitors/record-duration", async (req, res) => {
  try {
    if (!req.visitorId) return res.status(400).json({ error: "No visitor" });
    const jobId = parseInt(req.body?.job_id, 10);
    const seconds = Math.max(0, parseInt(req.body?.duration_seconds, 10));
    if (!jobId || isNaN(jobId)) return res.status(400).json({ error: "Invalid job_id" });
    const subq = db("visitor_job_clicks")
      .select("id")
      .where({ visitor_id: req.visitorId, job_id: jobId })
      .orderBy("clicked_at", "desc")
      .limit(1);
    await db("visitor_job_clicks")
      .whereIn("id", subq)
      .update({ time_spent_seconds: isNaN(seconds) ? null : seconds });
    res.status(204).send();
  } catch (err) {
    console.error("visitors/record-duration error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/visitors", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const [visitors, countRes] = await Promise.all([
      db("visitors")
        .select(
          "visitors.*",
          db.raw(
            "(SELECT COUNT(*)::int FROM visitor_job_clicks WHERE visitor_id = visitors.id) as job_clicks_count"
          ),
          db.raw(
            "(SELECT COUNT(*)::int FROM job_applications WHERE visitor_id = visitors.id) as cv_count"
          )
        )
        .orderByRaw("(CASE WHEN visitors.visit_count > 2 THEN 1 ELSE 0 END) DESC")
        .orderByRaw("job_clicks_count DESC")
        .orderByRaw("cv_count DESC")
        .limit(limit)
        .offset(offset),
      db("visitors").count("* as total"),
    ]);
    const total = Number((countRes[0] && countRes[0].total) || 0);

    const visitorIds = visitors.map((v) => v.id);
    const [clicks, applications] = await Promise.all([
      visitorIds.length
        ? db("visitor_job_clicks")
            .whereIn("visitor_id", visitorIds)
            .select("*")
            .orderBy("clicked_at", "desc")
        : [],
      visitorIds.length
        ? db("job_applications")
            .whereIn("visitor_id", visitorIds)
            .whereNotNull("visitor_id")
            .select("*")
        : [],
    ]);

    const clicksByVisitor = {};
    clicks.forEach((c) => {
      if (!clicksByVisitor[c.visitor_id]) clicksByVisitor[c.visitor_id] = [];
      clicksByVisitor[c.visitor_id].push(c);
    });
    const applicationsByVisitor = {};
    applications.forEach((a) => {
      if (!applicationsByVisitor[a.visitor_id]) applicationsByVisitor[a.visitor_id] = [];
      applicationsByVisitor[a.visitor_id].push(a);
    });

    const result = visitors.map((v) => {
      const { job_clicks_count, cv_count, ...rest } = v;
      return {
        ...rest,
        is_registered: !!v.user_id,
        job_clicks_count: Number(job_clicks_count) || 0,
        cv_count: Number(cv_count) || 0,
        job_clicks: (clicksByVisitor[v.id] || []).map((c) => ({
          ...c,
          time_spent_seconds: c.time_spent_seconds ?? null,
        })),
        cv_submissions: applicationsByVisitor[v.id] || [],
      };
    });

    res.json({
      visitors: result,
      total: Number(total),
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("api/visitors error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.use("/uploads", express.static("uploads"));

// Catch-all 404 (must be after all routes)
app.use((req, res) => {
  res.status(404).render("404", { message: "გვერდი ვერ მოიძებნა." });
});

// Sentry error handler (only if DSN is configured)
Sentry.setupExpressErrorHandler(app);
  app.use(function onError(err, req, res, next) {
    // The error id is attached to `res.sentry` to be returned
    // and optionally displayed to the user for support.
    res.statusCode = 500;
    res.end(res.sentry + "\n");
  });

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

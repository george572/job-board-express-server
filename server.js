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
const { slugify, extractIdFromSlug } = require("./utils/slugify"); // ← Add this

const app = express();
const port = process.env.PORT || 4000;
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);

// Base URL for SEO (sitemap, robots, canonicals)
const SITE_BASE_URL = process.env.SITE_BASE_URL || "https://samushao.ge";

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
app.use((req, res, next) => {
  res.locals.user = req.session?.user || null;
  next();
});

const { visitorMiddleware } = require("./middleware/visitor");
app.use(visitorMiddleware(db, extractIdFromSlug));

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
    const {
      category,
      company,
      job_experience,
      job_type,
      job_city,
      page = 1,
      limit: limitParam = 10,
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

    // Top salary jobs slider – skip when any filters are active
    let topSalaryJobs = [];
    let topSalaryTotalCount = 0;
    let topPopularJobs = [];
    let topPopularTotalCount = 0;
    let todayJobs = [];
    let todayJobsCount = 0;
    if (!filtersActive) {
      // Top salary: slot 1 = highest paid (prefer non-prioritized); slots 2-3 = prioritized with salary (fetched separately so today's jobs qualify)
        const isPrioritized = (j) => j.prioritize === true || j.prioritize === 1 || j.prioritize === "true";
        let topSalaryRaw = await db("jobs")
          .select("*")
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .whereNotNull("jobSalary_min")
          .orderBy("jobSalary_min", "desc")
          .limit(50);
        const prioritizedWithSalary = await db("jobs")
          .select("*")
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .where("prioritize", true)
          .whereNotNull("jobSalary_min")
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
        const nonPrioritized = topSalaryRaw.filter((j) => !isPrioritized(j));
        const slot1 = (nonPrioritized[0] || topSalaryRaw[0]);
        const prioritizedFor23 = dedupePrioritized.slice(0, 2);
        const usedIds = new Set([slot1?.id, ...prioritizedFor23.map((j) => j.id)].filter(Boolean));
        const restBySalary = topSalaryRaw.filter((j) => !usedIds.has(j.id));
        topSalaryJobs = [slot1, ...prioritizedFor23, ...restBySalary].filter(Boolean).slice(0, 20);
        topSalaryTotalCount = topSalaryJobs.length;

      // Top popular (most viewed): slot 1 = most viewed non-prioritized; slots 2-3 = prioritized (regardless of views)
        let topPopularRaw = await db("jobs")
          .select("*")
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .orderByRaw("COALESCE(view_count, 0) DESC")
          .limit(50);
        const prioritizedForPopular = await db("jobs")
          .select("*")
          .where("job_status", "approved")
          .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
          .where("prioritize", true)
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
        const nonPrioritizedPop = topPopularRaw.filter((j) => !isPrioritized(j));
        const slot1Pop = (nonPrioritizedPop[0] || topPopularRaw[0]);
        const prioritizedFor23Pop = dedupePrioritizedPop.slice(0, 2);
        const usedIdsPop = new Set([slot1Pop?.id, ...prioritizedFor23Pop.map((j) => j.id)].filter(Boolean));
        const restByViews = topPopularRaw.filter((j) => !usedIdsPop.has(j.id));
        topPopularJobs = [slot1Pop, ...prioritizedFor23Pop, ...restByViews].filter(Boolean).slice(0, 20);
        topPopularTotalCount = topPopularJobs.length;

      // Today's jobs (დღევანდელი ვაკანსიები)
      todayJobs = await db("jobs")
        .select("*")
        .where("job_status", "approved")
        .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
        .whereRaw("created_at::date = CURRENT_DATE")
        .orderByRaw("(CASE WHEN prioritize THEN 1 ELSE 0 END) DESC")
        .orderByRaw(
          `CASE job_premium_status WHEN 'premiumPlus' THEN 1 WHEN 'premium' THEN 2 WHEN 'regular' THEN 3 ELSE 4 END`
        )
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

    let query = db("jobs")
      .select("*")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
    let countQuery = db("jobs")
      .count("* as total")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())");
    // Exclude today's jobs from main listing (ყველა ვაკანსია) – unless filters/search active (today section is hidden)
    if (!filtersActive) {
      query.whereRaw("created_at::date < CURRENT_DATE");
      countQuery.whereRaw("created_at::date < CURRENT_DATE");
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
      const searchCondition = function () {
        this.where("jobName", "ilike", term)
          .orWhere("companyName", "ilike", term)
          .orWhere("jobDescription", "ilike", term);
      };
      query.andWhere(searchCondition);
      countQuery.andWhere(searchCondition);
    }

    // Get total count
    const [{ total }] = await countQuery;
    const totalPages = Math.ceil(total / Number(limit));

    let jobs = await query
      .orderByRaw("(CASE WHEN prioritize THEN 1 ELSE 0 END) DESC")
      .orderByRaw(
        `
        CASE job_premium_status
          WHEN 'premiumPlus' THEN 1
          WHEN 'premium' THEN 2
          WHEN 'regular' THEN 3
          ELSE 4
        END
      `,
      )
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(fetchLimit)
      .offset(offset);

    // Deduplicate: same job name + company = keep first (by our sort order)
    const seenKey = new Set();
    jobs = jobs.filter((j) => {
      const key = String(j.jobName || '').trim() + '|' + String(j.companyName || '').trim();
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });

    const baseUrl = "https://samushao.ge";
    const canonical = baseUrl + (pageNum === 1 ? "/" : "/?page=" + pageNum);
    res.render("index", {
      jobs,
      topSalaryJobs,
      topSalaryTotalCount,
      topPopularJobs,
      topPopularTotalCount,
      todayJobs,
      todayJobsCount,
      currentPage: pageNum,
      totalPages,
      totalJobs: total,
      filters: req.query,
      filtersActive,
      paginationBase: "/",
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

// Most popular jobs page – 20 most viewed; prioritized in slots 2-3 (same structure as highest paid)
app.get("/kvelaze-motkhovnadi-vakansiebi", async (req, res) => {
  try {
    const topLimit = 20;
    const isPrioritized = (j) => j.prioritize === true || j.prioritize === 1 || j.prioritize === "true";
    let jobsRaw = await db("jobs")
      .select("*")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .orderByRaw("COALESCE(view_count, 0) DESC")
      .limit(50);
    const prioritizedWithViews = await db("jobs")
      .select("*")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .where("prioritize", true)
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
    const nonPrioritized = jobsRaw.filter((j) => !isPrioritized(j));
    const slot1 = (nonPrioritized[0] || jobsRaw[0]);
    const prioritizedFor23 = dedupePrioritized.slice(0, 2);
    const usedIds = new Set([slot1?.id, ...prioritizedFor23.map((j) => j.id)].filter(Boolean));
    const restByViews = jobsRaw.filter((j) => !usedIds.has(j.id));
    const jobs = [slot1, ...prioritizedFor23, ...restByViews].filter(Boolean).slice(0, topLimit);

    res.render("index", {
      jobs,
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

    // Top salary: slot 1 = highest paid (prefer non-prioritized); slots 2-3 = prioritized with salary (fetched separately so today's jobs qualify)
    const isPrioritized = (j) => j.prioritize === true || j.prioritize === 1 || j.prioritize === "true";
    let jobsRaw = await db("jobs")
      .select("*")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .whereNotNull("jobSalary_min")
      .orderBy("jobSalary_min", "desc")
      .limit(50);
    const prioritizedWithSalary = await db("jobs")
      .select("*")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .where("prioritize", true)
      .whereNotNull("jobSalary_min")
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
    const nonPrioritized = jobsRaw.filter((j) => !isPrioritized(j));
    const slot1 = (nonPrioritized[0] || jobsRaw[0]);
    const prioritizedFor23 = dedupePrioritized.slice(0, 2);
    const usedIds = new Set([slot1?.id, ...prioritizedFor23.map((j) => j.id)].filter(Boolean));
    const restBySalary = jobsRaw.filter((j) => !usedIds.has(j.id));
    const jobs = [slot1, ...prioritizedFor23, ...restBySalary].filter(Boolean).slice(0, topLimit);

    res.render("index", {
      jobs,
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
      .select("*")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .whereRaw("created_at::date = CURRENT_DATE")
      .orderByRaw("(CASE WHEN prioritize THEN 1 ELSE 0 END) DESC")
      .orderByRaw(
        `CASE job_premium_status WHEN 'premiumPlus' THEN 1 WHEN 'premium' THEN 2 WHEN 'regular' THEN 3 ELSE 4 END`
      )
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
    res.render("sent-cvs", {
      jobs: orderedJobs,
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

// get vacancy inner page
app.get("/vakansia/:slug", async (req, res) => {
  try {
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

    // Use raw SQL for reliable increment (avoids Knex .increment() quirks)
    try {
      await db.raw(
        "UPDATE jobs SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?",
        [jobId]
      );
    } catch (incErr) {
      console.error("view_count increment error:", incErr);
    }

    if (req.visitorId) {
      const cat = job.category_id
        ? await db("categories").where("id", job.category_id).select("name").first()
        : null;
      await db("visitor_job_clicks").insert({
        visitor_id: req.visitorId,
        job_id: jobId,
        job_salary: job.jobSalary || null,
        job_title: job.jobName || null,
        category_id: job.category_id || null,
        job_category_name: (cat && cat.name) || null,
        job_city: job.job_city || null,
        job_experience: job.job_experience || null,
        job_type: job.job_type || null,
      });
    }

    // Generate correct slug and redirect if URL doesn't match
    const correctSlug = slugify(job.jobName) + "-" + job.id;
    if (slug !== correctSlug) {
      return res.redirect(301, `/vakansia/${correctSlug}`);
    }

    // Related jobs: same category OR prioritized (from any category); prioritized and same-category first
    const relatedJobs = await db("jobs")
      .where("job_status", "approved")
      .whereRaw("(expires_at IS NULL OR expires_at > NOW())")
      .where((qb) => {
        qb.where("category_id", job.category_id).orWhere("prioritize", true);
      })
      .whereNot("id", jobId)
      .orderByRaw("(CASE WHEN prioritize THEN 1 ELSE 0 END) DESC")
      .orderByRaw("(CASE WHEN category_id = ? THEN 1 ELSE 0 END) DESC", [job.category_id])
      .orderBy("created_at", "desc")
      .limit(5);

    const isExpired = job.expires_at && new Date(job.expires_at) <= new Date();

    // Has this user already sent CV to this job?
    let userAlreadyApplied = false;
    if (req.session?.user?.uid) {
      const application = await db("job_applications")
        .where({ user_id: req.session.user.uid, job_id: jobId })
        .first();
      userAlreadyApplied = !!application;
    }

    const jobDescription =
      job.job_description && job.job_description.length > 0
        ? job.job_description.substring(0, 155)
        : job.jobName + " at " + job.companyName;
    const jobCanonical =
      "https://samushao.ge/vakansia/" + slugify(job.jobName) + "-" + job.id;
    res.render("job-detail", {
      job,
      relatedJobs,
      slugify,
      userAlreadyApplied,
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

cloudinary.config({
  cloud_name: "dd7gz0aqv",
  api_key: "345132216437496",
  api_secret: "gRBZZuGtsxALJlZ7sxh8SCwgTVw",
});

// login router
// Filter counts (contextual: when category=2 active, other counts reflect jobs in that category)
app.get("/api/filter-counts", async (req, res) => {
  try {
    const { category, min_salary, job_experience, job_type, job_city, q } = req.query;
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
        query = query.whereRaw("created_at::date < CURRENT_DATE");
      }
      return query;
    };

    const applyOtherFilters = (query, exclude) => {
      if (exclude !== "category" && category) {
        const cats = Array.isArray(category) ? category : [category];
        query.whereIn("category_id", cats);
      }
      if (exclude !== "min_salary" && min_salary) {
        const min = parseInt(min_salary, 10);
        if (!isNaN(min)) query.where("jobSalary_min", ">=", min);
      }
      if (exclude !== "job_experience" && job_experience) {
        const exp = Array.isArray(job_experience) ? job_experience : [job_experience];
        query.whereIn("job_experience", exp);
      }
      if (exclude !== "job_type" && job_type) {
        const types = Array.isArray(job_type) ? job_type : [job_type];
        query.whereIn("job_type", types);
      }
      if (exclude !== "job_city" && job_city) {
        const cities = Array.isArray(job_city) ? job_city : [job_city];
        query.whereIn("job_city", cities);
      }
      if (exclude !== "q" && filterSearchTerm) {
        const term =
          "%" + filterSearchTerm.replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
        query.andWhere(function () {
          this.where("jobName", "ilike", term)
            .orWhere("companyName", "ilike", term)
            .orWhere("jobDescription", "ilike", term);
        });
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

    res.json({
      category: categoryCounts,
      min_salary: salaryCounts,
      job_experience: experienceCounts,
      job_type: jobTypeCounts,
      job_city: cityCounts,
    });
  } catch (err) {
    console.error("filter-counts error:", err);
    res.status(500).json({ error: err.message });
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
        user_type: "pending",
      }),
    });

    const authData = await authResponse.json();

    req.session.user = {
      uid: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      user_type: authData.user?.user_type || authData.user_type || "pending",
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
// user type update
app.post("/api/user/update-session-type", (req, res) => {
  const { user_type } = req.body;

  if (req.session.user) {
    req.session.user.user_type = user_type;
  }

  res.json({ success: true });
});

// jobs router
const jobsRouter = require("./routes/jobs");
app.get("/jobs/email-queue-status", (req, res) => {
  res.json(jobsRouter.getEmailQueueStatus());
});
app.post("/jobs/email-queue-kick", (req, res) => {
  jobsRouter.kickEmailQueue();
  res.json({ ok: true, pending: jobsRouter.getEmailQueueStatus().pending });
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

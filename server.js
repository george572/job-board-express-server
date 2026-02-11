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

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

app.use(
  cors({
    origin: [
      "http://localhost:4000",
      "http://localhost:4001",
      "https://samushao.ge",
      "https://samushao-admin.web.app",
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

    const filterParamKeys = [
      "category",
      "company",
      "job_experience",
      "job_type",
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
    if (!filtersActive) {
      topSalaryJobs = await db("jobs")
        .select("*")
        .where("job_status", "approved")
        .whereNotNull("jobSalary_min")
        .orderBy("jobSalary_min", "desc")
        .limit(20);
    }

    let query = db("jobs").select("*").where("job_status", "approved");
    let countQuery = db("jobs")
      .count("* as total")
      .where("job_status", "approved"); // ADD THIS

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

    const jobs = await query
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
      .limit(fetchLimit)
      .offset(offset);

    const baseUrl = "https://samushao.ge";
    const canonical = baseUrl + (pageNum === 1 ? "/" : "/?page=" + pageNum);
    res.render("index", {
      jobs,
      topSalaryJobs,
      currentPage: pageNum,
      totalPages,
      totalJobs: total,
      filters: req.query,
      filtersActive,
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
    const jobId = extractIdFromSlug(slug);

    if (!jobId) {
      return res.status(404).render("404", { message: "Job not found" });
    }

    const job = await db("jobs")
      .where({ id: jobId, job_status: "approved" })
      .first();

    if (!job) {
      return res.status(404).render("404", { message: "Job not found" });
    }

    // Generate correct slug and redirect if URL doesn't match
    const correctSlug = slugify(job.jobName) + "-" + job.id;
    if (slug !== correctSlug) {
      return res.redirect(301, `/vakansia/${correctSlug}`);
    }

    const relatedJobs = await db("jobs")
      .where("job_status", "approved")
      .where("category_id", job.category_id)
      .whereNot("id", jobId)
      .limit(5);

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

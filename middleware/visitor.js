const crypto = require("crypto");
const VISITOR_COOKIE = "vid";
const PENDING_CLICKS_COOKIE = "pclk";
const PENDING_CLICKS_MAX_AGE = 24 * 60 * 60; // 24 hours
const VISITOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds
const NEW_VISIT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const MIN_JOBS_BEFORE_RECORD = 2;

function generateVisitorUid() {
  return crypto.randomBytes(16).toString("hex");
}

function getVisitorUidFromRequest(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const match = raw.match(/\bvid=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function getPendingClicksFromRequest(req) {
  const raw = req.headers.cookie;
  if (!raw) return [];
  const match = raw.match(/\bpclk=([^;]+)/);
  if (!match) return [];
  try {
    const decoded = decodeURIComponent(match[1]);
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isJobDetailPath(path) {
  return /^\/vakansia\/[^/]+$/.test(path);
}

function isVisitorCreationPath(path) {
  return isJobDetailPath(path);
}

/**
 * Middleware that assigns/identifies visitors. Only creates new visitors when
 * they have visited at least MIN_JOBS_BEFORE_RECORD job pages.
 */
function visitorMiddleware(db, extractIdFromSlug) {
  return async (req, res, next) => {
    try {
      const uid = getVisitorUidFromRequest(req);
      const now = new Date();

      if (uid) {
        const visitor = await db("visitors").where("visitor_uid", uid).first();
        if (visitor) {
          if (isJobDetailPath(req.path)) {
            const lastSeen = visitor.last_seen ? new Date(visitor.last_seen) : null;
            const isNewVisit =
              !lastSeen || now - lastSeen > NEW_VISIT_THRESHOLD_MS;
            const newVisitCount = isNewVisit
              ? (visitor.visit_count || 1) + 1
              : visitor.visit_count || 1;
            const userUpdate =
              req.session?.user?.uid && !visitor.user_id
                ? { user_id: req.session.user.uid }
                : {};
            await db("visitors").where("id", visitor.id).update({
              last_seen: now,
              visit_count: newVisitCount,
              ...userUpdate,
            });
            req.visitorId = visitor.id;
            req.visitor = Object.assign({}, visitor, {
              last_seen: now,
              visit_count: newVisitCount,
              user_id: userUpdate.user_id || visitor.user_id,
              isRegisteredUser: !!(userUpdate.user_id || visitor.user_id),
            });
          } else {
            req.visitorId = visitor.id;
            req.visitor = Object.assign({}, visitor, {
              isRegisteredUser: !!visitor.user_id,
            });
          }
          return next();
        }
      }

      if (!isVisitorCreationPath(req.path)) {
        return next();
      }

      const slug = req.path.replace(/^\/vakansia\//, "");
      const currentJobId = extractIdFromSlug ? parseInt(extractIdFromSlug(slug), 10) : null;
      if (!currentJobId || isNaN(currentJobId)) {
        return next();
      }

      const pending = getPendingClicksFromRequest(req);
      const seenIds = new Set(pending.map((p) => p.j));
      if (!seenIds.has(currentJobId)) {
        seenIds.add(currentJobId);
        pending.push({ j: currentJobId, t: now.getTime() });
      }

      if (seenIds.size < MIN_JOBS_BEFORE_RECORD) {
        res.cookie(PENDING_CLICKS_COOKIE, JSON.stringify(pending), {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: PENDING_CLICKS_MAX_AGE * 1000,
        });
        return next();
      }

      const visitorUid = generateVisitorUid();
      const [visitor] = await db("visitors")
        .insert({
          visitor_uid: visitorUid,
          user_id: req.session?.user?.uid || null,
          visit_count: 1,
          first_seen: now,
          last_seen: now,
        })
        .returning("*");

      for (const p of pending) {
        const j = parseInt(p.j, 10);
        if (isNaN(j) || j === currentJobId) continue;
        const job = await db("jobs").where({ id: j }).first();
        if (!job) continue;
        const cat = job.category_id
          ? await db("categories").where("id", job.category_id).select("name").first()
          : null;
        await db("visitor_job_clicks").insert({
          visitor_id: visitor.id,
          job_id: j,
          job_salary: job.jobSalary || null,
          job_title: job.jobName || null,
          category_id: job.category_id || null,
          job_category_name: (cat && cat.name) || null,
          job_city: job.job_city || null,
          job_experience: job.job_experience || null,
          job_type: job.job_type || null,
        });
      }

      req.visitorId = visitor.id;
      req.visitor = Object.assign({}, visitor, {
        isRegisteredUser: !!visitor.user_id,
      });
      res.cookie(VISITOR_COOKIE, visitorUid, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: VISITOR_COOKIE_MAX_AGE * 1000,
        signed: false,
      });
      res.clearCookie(PENDING_CLICKS_COOKIE);
      next();
    } catch (err) {
      console.error("visitor middleware error:", err);
      next();
    }
  };
}

module.exports = { visitorMiddleware };

const crypto = require("crypto");
const NodeCache = require("node-cache");

const VISITOR_COOKIE = "vid";
const PENDING_CLICKS_COOKIE = "pclk";
const PENDING_CLICKS_MAX_AGE = 24 * 60 * 60;
const VISITOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const NEW_VISIT_THRESHOLD_MS = 30 * 60 * 1000;
const MIN_JOBS_BEFORE_RECORD = 2;

const visitorCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

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

function visitorMiddleware(db, extractIdFromSlug) {
  return async (req, res, next) => {
    try {
      const uid = getVisitorUidFromRequest(req);
      const now = new Date();

      if (uid) {
        let visitor = visitorCache.get(uid);
        if (!visitor) {
          visitor = await db("visitors").where("visitor_uid", uid).first();
          if (visitor) visitorCache.set(uid, visitor);
        }
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
            db("visitors").where("id", visitor.id).update({
              last_seen: now,
              visit_count: newVisitCount,
              ...userUpdate,
            }).catch((e) => console.error("visitor update error:", e?.message));
            const updated = Object.assign({}, visitor, {
              last_seen: now,
              visit_count: newVisitCount,
              user_id: userUpdate.user_id || visitor.user_id,
              isRegisteredUser: !!(userUpdate.user_id || visitor.user_id),
            });
            visitorCache.set(uid, updated);
            req.visitorId = visitor.id;
            req.visitor = updated;
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

      const pendingJobs = pending
        .map((p) => parseInt(p.j, 10))
        .filter((j) => !isNaN(j) && j !== currentJobId);
      if (pendingJobs.length > 0) {
        const jobs = await db("jobs").whereIn("id", pendingJobs).select("id", "jobSalary", "jobName", "category_id", "job_city", "job_experience", "job_type");
        const catIds = [...new Set(jobs.map((j) => j.category_id).filter(Boolean))];
        const cats = catIds.length > 0 ? await db("categories").whereIn("id", catIds).select("id", "name") : [];
        const catMap = Object.fromEntries(cats.map((c) => [c.id, c.name]));
        const inserts = jobs.map((job) => ({
          visitor_id: visitor.id,
          job_id: job.id,
          job_salary: job.jobSalary || null,
          job_title: job.jobName || null,
          category_id: job.category_id || null,
          job_category_name: catMap[job.category_id] || null,
          job_city: job.job_city || null,
          job_experience: job.job_experience || null,
          job_type: job.job_type || null,
        }));
        if (inserts.length > 0) {
          await db("visitor_job_clicks").insert(inserts);
        }
      }

      req.visitorId = visitor.id;
      req.visitor = Object.assign({}, visitor, {
        isRegisteredUser: !!visitor.user_id,
      });
      visitorCache.set(visitorUid, visitor);
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

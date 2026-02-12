const crypto = require("crypto");
const VISITOR_COOKIE = "vid";
const VISITOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds
const NEW_VISIT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function generateVisitorUid() {
  return crypto.randomBytes(16).toString("hex");
}

function getVisitorUidFromRequest(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const match = raw.match(/\bvid=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Middleware that assigns/identifies visitors and tracks visit count.
 * Sets req.visitorId (integer) and req.visitor (object).
 * - visitor_uid: always a random id (cookie), never replaced
 * - user_id: set when the user is logged in (their users UID)
 * - req.visitor.isRegisteredUser: true when user_id is set
 */
function visitorMiddleware(db) {
  return async (req, res, next) => {
    try {
      const uid = getVisitorUidFromRequest(req);
      const now = new Date();

      if (uid) {
        const visitor = await db("visitors").where("visitor_uid", uid).first();
        if (visitor) {
          const lastSeen = visitor.last_seen ? new Date(visitor.last_seen) : null;
          const isNewVisit =
            !lastSeen || now - lastSeen > NEW_VISIT_THRESHOLD_MS;
          await db("visitors")
            .where("id", visitor.id)
            .update({
              last_seen: now,
              visit_count: isNewVisit
                ? (visitor.visit_count || 1) + 1
                : visitor.visit_count || 1,
              ...(req.session?.user?.uid &&
                !visitor.user_id && { user_id: req.session.user.uid }),
            });
          const [updated] = await db("visitors")
            .where("id", visitor.id)
            .select("*");
          req.visitorId = visitor.id;
          req.visitor = Object.assign({}, updated || visitor, {
            isRegisteredUser: !!(updated || visitor).user_id,
          });
          return next();
        }
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
      next();
    } catch (err) {
      console.error("visitor middleware error:", err);
      next();
    }
  };
}

module.exports = { visitorMiddleware };

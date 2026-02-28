/**
 * Cookie to prevent duplicate feedback per job (anonymous, same browser).
 * Cookie name: jfb (job feedback)
 */
const COOKIE_NAME = "jfb";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const MAX_IDS = 100;

function parseJobFeedbackIdsFromCookie(req) {
  const raw = req?.headers?.cookie;
  if (!raw) return new Set();
  const match = raw.match(new RegExp(`\\b${COOKIE_NAME}=([^;]+)`));
  if (!match) return new Set();
  try {
    const ids = decodeURIComponent(match[1])
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);
    return new Set(ids.slice(-MAX_IDS));
  } catch {
    return new Set();
  }
}

function setJobFeedbackCookie(res, currentIds, jobId) {
  const set = new Set(currentIds);
  set.add(jobId);
  const value = Array.from(set).slice(-MAX_IDS).join(",");
  res.cookie(COOKIE_NAME, value, {
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
}

module.exports = {
  parseJobFeedbackIdsFromCookie,
  setJobFeedbackCookie,
};

/**
 * Cookie-based tracking of job form submissions (one per job per user).
 * Cookie name: jfs (job form submitted)
 * Value: comma-separated job IDs, e.g. "123,456"
 */
const COOKIE_NAME = "jfs";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year
const MAX_IDS = 100;

function parseJobIdsFromCookie(req) {
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

function addJobIdAndGetNewValue(currentIds, jobId) {
  const set = new Set(currentIds);
  set.add(jobId);
  const arr = Array.from(set).slice(-MAX_IDS);
  return arr.join(",");
}

function setFormSubmittedCookie(res, currentIds, jobId) {
  const value = addJobIdAndGetNewValue(currentIds, jobId);
  res.cookie(COOKIE_NAME, value, {
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
}

module.exports = {
  parseJobIdsFromCookie,
  setFormSubmittedCookie,
};

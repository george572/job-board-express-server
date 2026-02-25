/**
 * Server-side cache for filter counts. Invalidated only when new jobs are inserted.
 * stdTTL: 0 means no expiry – we invalidate explicitly on job upload.
 */
const NodeCache = require("node-cache");
const filterCountsCache = new NodeCache({ stdTTL: 0 });

function getFilterCountsKey(query) {
  const parts = [];
  if (query.category) (Array.isArray(query.category) ? query.category : [query.category]).forEach((c) => parts.push("category=" + c));
  if (query.min_salary) parts.push("min_salary=" + query.min_salary);
  if (query.job_experience) (Array.isArray(query.job_experience) ? query.job_experience : [query.job_experience]).forEach((e) => parts.push("job_experience=" + e));
  if (query.job_type) (Array.isArray(query.job_type) ? query.job_type : [query.job_type]).forEach((t) => parts.push("job_type=" + t));
  if (query.work_mode) (Array.isArray(query.work_mode) ? query.work_mode : [query.work_mode]).forEach((m) => parts.push("work_mode=" + m));
  if (query.job_city) (Array.isArray(query.job_city) ? query.job_city : [query.job_city]).forEach((c) => parts.push("job_city=" + c));
  if (query.q && String(query.q).trim()) parts.push("q=" + encodeURIComponent(String(query.q).trim()));
  return parts.sort().join("&") || "base";
}

function get(key) {
  return filterCountsCache.get(key);
}

function set(key, value) {
  filterCountsCache.set(key, value);
}

function invalidate() {
  filterCountsCache.flushAll();
}

module.exports = { getFilterCountsKey, get, set, invalidate };

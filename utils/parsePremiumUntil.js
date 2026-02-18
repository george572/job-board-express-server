/**
 * Parse premium_until from admin input.
 * - Number (e.g. 7): days from today → premium expires in 7 days
 * - Date string: parse as date (supports ISO, DD.MM.YYYY, DD/MM/YYYY, etc.)
 * @param {number|string} input
 * @returns {string|null} ISO date string (YYYY-MM-DD) or null if invalid
 */
function parsePremiumUntil(input) {
  if (input === undefined || input === null || input === "") return null;

  const trimmed = String(input).trim();
  if (!trimmed) return null;

  // Numeric = days from today
  const asNum = parseInt(trimmed, 10);
  if (!isNaN(asNum) && String(asNum) === trimmed) {
    if (asNum < 0) return null;
    const d = new Date();
    d.setDate(d.getDate() + asNum);
    return d.toISOString().slice(0, 10);
  }

  // Try parsing as date
  // ISO: 2025-02-25
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const date = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
    if (!isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }

  // DD.MM.YYYY or DD/MM/YYYY
  const dmyMatch = trimmed.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    const date = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
    if (!isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }

  // YYYY.MM.DD
  const ymdMatch = trimmed.match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})$/);
  if (ymdMatch) {
    const [, y, m, d] = ymdMatch;
    const date = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
    if (!isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }

  // Fallback: native Date parse
  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

  return null;
}

module.exports = { parsePremiumUntil };

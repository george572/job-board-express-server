/**
 * In-memory cache for top CV-fit Pinecone results (user_uid -> { matches, expiresAt }).
 * TTL 2 hours. Call invalidate(userId) when CV is uploaded or deleted so fresh data is fetched.
 */
const TTL_MS = 2 * 60 * 60 * 1000;
const cache = new Map();

function get(userId) {
  return cache.get(userId);
}

function set(userId, data) {
  cache.set(userId, { ...data, expiresAt: Date.now() + TTL_MS });
}

/**
 * Remove cached CV-fit for user. Next request will fetch fresh matches from Pinecone.
 */
function invalidate(userId) {
  if (userId) cache.delete(userId);
}

module.exports = { get, set, invalidate, TTL_MS };

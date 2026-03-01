const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Bottleneck = require("bottleneck");

const JINA_API_KEY = (process.env.JINA_API_KEY || "").trim();

// Jina free tier: 500 RPM / ~8.3 RPS. No delay between requests; rely on concurrent limit.
const limiter = new Bottleneck({
  maxConcurrent: 2,
  minTime: 0,
  reservoir: 60,
  reservoirRefreshAmount: 60,
  reservoirRefreshInterval: 60_000,
});

async function embedWithJina(texts, task) {
  return limiter.schedule(() => _embedWithJina(texts, task));
}

async function _embedWithJina(texts, task) {
  if (!JINA_API_KEY) throw new Error("JINA_API_KEY is required for Jina embeddings");
  const res = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${JINA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: "jina-embeddings-v3",
      task,
      dimensions: 1024,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jina embed failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  return (json.data || []).map((d) => d.embedding);
}

module.exports = { embedWithJina };

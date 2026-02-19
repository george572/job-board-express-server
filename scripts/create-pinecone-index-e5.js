#!/usr/bin/env node
/**
 * Create Pinecone index with multilingual-e5-large for candidate–job matching.
 * Run once to create the index, then set PINECONE_INDEX in .env and run backfill.
 *
 * Usage: node scripts/create-pinecone-index-e5.js
 *
 * Requires: PINECONE_API_KEY in .env
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Pinecone } = require("@pinecone-database/pinecone");

const INDEX_NAME = process.env.PINECONE_INDEX || "samushao-candidates";

async function main() {
  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) {
    console.error("Missing PINECONE_API_KEY in .env");
    process.exit(1);
  }

  const pc = new Pinecone({ apiKey });

  console.log(`Creating index "${INDEX_NAME}" with multilingual-e5-large...`);

  try {
    await pc.createIndexForModel({
      name: INDEX_NAME,
      cloud: "aws",
      region: "us-east-1",
      embed: {
        model: "multilingual-e5-large",
        fieldMap: { text: "text" },
        writeParameters: { input_type: "passage", truncate: "END" },
        readParameters: { input_type: "query", truncate: "END" },
      },
      waitUntilReady: true,
      suppressConflicts: true,
    });
    console.log(`Index "${INDEX_NAME}" is ready.`);
  } catch (err) {
    console.error("Failed to create index:", err.message);
    process.exit(1);
  }
}

main();

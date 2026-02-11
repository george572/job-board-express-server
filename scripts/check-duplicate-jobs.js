#!/usr/bin/env node
/**
 * Check for duplicate jobs in the database.
 * Run: node scripts/check-duplicate-jobs.js
 */
require('dotenv').config();
const knex = require('knex');
const knexfile = require('../knexfile');
const env = process.env.NODE_ENV || 'development';
const db = knex(knexfile[env]);

async function main() {
  // Jobs with same name + company (potential duplicates)
  const dupes = await db('jobs')
    .select('jobName', 'companyName', db.raw('array_agg(id ORDER BY id) as ids'), db.raw('count(*) as cnt'))
    .where('job_status', 'approved')
    .groupBy('jobName', 'companyName')
    .having(db.raw('count(*) > 1'));

  if (dupes.length === 0) {
    console.log('✅ No duplicate jobs (same name + company) found.');
    process.exit(0);
    return;
  }

  console.log(`⚠️  Found ${dupes.length} job(s) with duplicate name+company:`);
  dupes.forEach((r) => {
    console.log(`   "${r.jobName}" @ ${r.companyName} – IDs: ${r.ids.join(', ')}`);
  });
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

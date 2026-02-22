/**
 * Add database indexes for common query patterns.
 * Run once: node scripts/add-performance-indexes.js
 */
require("dotenv").config();
const knex = require("knex");
const knexConfig = require("../knexfile");
const env = process.env.NODE_ENV || "development";
const db = knex(knexConfig[env]);

const INDEXES = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_status_expires
   ON jobs (job_status, expires_at)`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_category_status
   ON jobs (category_id, job_status)`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_premium_status
   ON jobs (job_premium_status) WHERE job_status = 'approved'`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_salary_min
   ON jobs ("jobSalary_min") WHERE job_status = 'approved' AND "jobSalary_min" IS NOT NULL`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_created_at
   ON jobs (created_at DESC) WHERE job_status = 'approved'`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_view_count
   ON jobs (view_count DESC NULLS LAST) WHERE job_status = 'approved'`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_accept_form
   ON jobs (accept_form_submissions) WHERE job_status = 'approved' AND accept_form_submissions IS TRUE`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_visitor_job_clicks_visitor
   ON visitor_job_clicks (visitor_id)`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_visitors_uid
   ON visitors (visitor_uid)`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_visitors_user_id
   ON visitors (user_id) WHERE user_id IS NOT NULL`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_applications_user_job
   ON job_applications (user_id, job_id)`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_applications_visitor
   ON job_applications (visitor_id) WHERE visitor_id IS NOT NULL`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_form_submissions_job_user
   ON job_form_submissions (job_id, user_id)`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_form_submissions_job_visitor
   ON job_form_submissions (job_id, visitor_id)`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_enlisted_fb_user
   ON enlisted_in_fb (user_id) WHERE user_id IS NOT NULL`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_enlisted_fb_visitor
   ON enlisted_in_fb (visitor_id) WHERE visitor_id IS NOT NULL`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_expire
   ON session (expire)`,
];

async function run() {
  console.log(`Adding ${INDEXES.length} indexes...`);
  for (const sql of INDEXES) {
    const name = sql.match(/IF NOT EXISTS (\w+)/)?.[1] || "unknown";
    try {
      await db.raw(sql);
      console.log(`  ✓ ${name}`);
    } catch (e) {
      if (e.message.includes("already exists")) {
        console.log(`  - ${name} (already exists)`);
      } else {
        console.error(`  ✗ ${name}: ${e.message}`);
      }
    }
  }
  console.log("Done.");
  await db.destroy();
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

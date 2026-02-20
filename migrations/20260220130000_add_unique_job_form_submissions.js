/**
 * Add unique constraints to prevent duplicate form submissions (race condition / double-click).
 * One submission per (job_id, user_id) for logged-in users, and per (job_id, visitor_id) for visitors.
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS job_form_submissions_job_user_unique
    ON job_form_submissions (job_id, user_id) WHERE user_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS job_form_submissions_job_visitor_unique
    ON job_form_submissions (job_id, visitor_id) WHERE visitor_id IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw("DROP INDEX IF EXISTS job_form_submissions_job_user_unique");
  await knex.raw("DROP INDEX IF EXISTS job_form_submissions_job_visitor_unique");
};

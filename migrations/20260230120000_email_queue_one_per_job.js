/**
 * Allow multiple new_job queue rows per company (one per job).
 * Drop unique(company_email_lower, email_type) for new_job.
 * Add unique(job_id, email_type) so the same job is not queued twice.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;

  await knex.raw(
    "DROP INDEX IF EXISTS new_job_email_queue_company_email_new_job_unique"
  );
  await knex.raw(`
    CREATE UNIQUE INDEX new_job_email_queue_job_id_new_job_unique
    ON new_job_email_queue (job_id)
    WHERE (email_type = 'new_job' OR email_type IS NULL)
  `);
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;

  await knex.raw(
    "DROP INDEX IF EXISTS new_job_email_queue_job_id_new_job_unique"
  );
  await knex.raw(`
    CREATE UNIQUE INDEX new_job_email_queue_company_email_new_job_unique
    ON new_job_email_queue (company_email_lower, email_type)
    WHERE (email_type = 'new_job' OR email_type IS NULL)
  `);
};

/**
 * Allow multiple best_candidate_followup rows per company in new_job_email_queue
 * (one per job). Keep unique(company_email_lower, email_type) only for email_type = 'new_job'.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;

  await knex.raw(
    "ALTER TABLE new_job_email_queue DROP CONSTRAINT IF EXISTS new_job_email_queue_company_email_lower_email_type_unique"
  );
  await knex.raw(`
    CREATE UNIQUE INDEX new_job_email_queue_company_email_new_job_unique
    ON new_job_email_queue (company_email_lower, email_type)
    WHERE (email_type = 'new_job' OR email_type IS NULL)
  `);
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;

  await knex.raw(
    "DROP INDEX IF EXISTS new_job_email_queue_company_email_new_job_unique"
  );
  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.unique(["company_email_lower", "email_type"]);
  });
};

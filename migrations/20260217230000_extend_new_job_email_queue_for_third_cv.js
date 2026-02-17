/**
 * Extend new_job_email_queue to support third CV marketing emails.
 * Adds email_type, subject, html. Third CV rows use email_type='third_cv_marketing'
 * and store pre-built subject/html.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;

  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.string("email_type", 32).defaultTo("new_job");
    table.string("subject", 500).nullable();
    table.text("html").nullable();
  });

  // Change unique(job_id) to unique(job_id, email_type)
  await knex.raw("ALTER TABLE new_job_email_queue DROP CONSTRAINT IF EXISTS new_job_email_queue_job_id_unique");
  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.unique(["job_id", "email_type"]);
  });

  // Change unique(company_email_lower) to unique(company_email_lower, email_type)
  // so same company can have both new_job and third_cv_marketing rows
  await knex.raw("ALTER TABLE new_job_email_queue DROP CONSTRAINT IF EXISTS new_job_email_queue_company_email_lower_unique");
  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.unique(["company_email_lower", "email_type"]);
  });
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;

  await knex.raw("ALTER TABLE new_job_email_queue DROP CONSTRAINT IF EXISTS new_job_email_queue_job_id_email_type_unique");
  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.unique(["job_id"]);
  });

  await knex.raw("ALTER TABLE new_job_email_queue DROP CONSTRAINT IF EXISTS new_job_email_queue_company_email_lower_email_type_unique");
  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.unique(["company_email_lower"]);
  });

  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.dropColumn("email_type");
    table.dropColumn("subject");
    table.dropColumn("html");
  });
};

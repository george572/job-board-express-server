/**
 * Ensure only one queue row per company (one email per company).
 * Duplicate inserts will fail with unique violation.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;
  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.unique(["company_email_lower"]);
  });
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;
  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.dropUnique(["company_email_lower"]);
  });
};

/**
 * Track which companies we've sent new-job emails to (shared across server instances).
 * Prevents 3x emails when running multiple Node processes.
 */
exports.up = async function (knex) {
  await knex.schema.createTable("new_job_email_sent", (table) => {
    table.string("company_email_lower", 255).primary();
    table.timestamp("sent_at").notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("new_job_email_sent");
};

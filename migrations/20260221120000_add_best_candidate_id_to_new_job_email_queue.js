/**
 * Add best_candidate_id to new_job_email_queue for new-job marketing flow.
 * Stores user_uid or "no_cv_123" so admin dashboard can show CV link or contact info.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;

  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.string("best_candidate_id", 128).nullable();
  });
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;

  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.dropColumn("best_candidate_id");
  });
};

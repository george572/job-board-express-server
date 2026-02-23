/**
 * Store candidate cv_url / email / phone on new_job_email_queue at queue time
 * so we can trace back which candidate was suggested even if they change or delete later.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;

  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.text("best_candidate_cv_url").nullable();
    table.string("best_candidate_email", 255).nullable();
    table.string("best_candidate_phone", 80).nullable();
  });
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;

  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.dropColumn("best_candidate_cv_url");
    table.dropColumn("best_candidate_email");
    table.dropColumn("best_candidate_phone");
  });
};

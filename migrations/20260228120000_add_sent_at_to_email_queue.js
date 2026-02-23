/**
 * Add sent_at to new_job_email_queue so follow-up rows can be marked as sent
 * instead of deleted — preserving best_candidate_id for admin display.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;
  const hasSentAt = await knex.schema.hasColumn("new_job_email_queue", "sent_at");
  if (hasSentAt) return;
  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.timestamp("sent_at").nullable().defaultTo(null);
  });
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable("new_job_email_queue");
  if (!hasTable) return;
  const hasSentAt = await knex.schema.hasColumn("new_job_email_queue", "sent_at");
  if (!hasSentAt) return;
  await knex.schema.alterTable("new_job_email_queue", (table) => {
    table.dropColumn("sent_at");
  });
};

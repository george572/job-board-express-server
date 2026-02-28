/**
 * Add user_id and visitor_id to job_feedback for duplicate prevention.
 * Stored only for dedup; HR never sees these. Feedback remains anonymous.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("job_feedback", (table) => {
    table.string("user_id").nullable();
    table.integer("visitor_id").unsigned().nullable().references("visitors.id").onDelete("SET NULL");
  });
  await knex.schema.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS job_feedback_user_unique ON job_feedback (job_id, user_id) WHERE user_id IS NOT NULL"
  );
  await knex.schema.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS job_feedback_visitor_unique ON job_feedback (job_id, visitor_id) WHERE visitor_id IS NOT NULL"
  );
};

exports.down = async function (knex) {
  await knex.schema.raw("DROP INDEX IF EXISTS job_feedback_user_unique");
  await knex.schema.raw("DROP INDEX IF EXISTS job_feedback_visitor_unique");
  await knex.schema.alterTable("job_feedback", (table) => {
    table.dropColumn("user_id");
    table.dropColumn("visitor_id");
  });
};

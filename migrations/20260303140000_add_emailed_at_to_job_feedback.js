/**
 * Add emailed_at to job_feedback to avoid sending the same feedback twice.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("job_feedback", (table) => {
    table.timestamp("emailed_at").nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("job_feedback", (table) => {
    table.dropColumn("emailed_at");
  });
};

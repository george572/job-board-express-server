/**
 * Queue table for new-job marketing emails. Replaces file-based queue.
 * Rows are deleted after successful send.
 */
exports.up = async function (knex) {
  await knex.schema.createTable("new_job_email_queue", (table) => {
    table.increments("id").primary();
    table.integer("job_id").notNullable().references("id").inTable("jobs").onDelete("CASCADE");
    table.string("company_email_lower", 255).notNullable();
    table.timestamp("send_after").notNullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.unique(["job_id"]);
    table.index(["send_after"]);
    table.index(["company_email_lower"]);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("new_job_email_queue");
};

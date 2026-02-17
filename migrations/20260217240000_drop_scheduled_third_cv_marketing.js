/**
 * Drop scheduled_third_cv_marketing – third CV emails now use new_job_email_queue.
 */
exports.up = async function (knex) {
  await knex.schema.dropTableIfExists("scheduled_third_cv_marketing");
};

exports.down = async function (knex) {
  await knex.schema.createTable("scheduled_third_cv_marketing", (table) => {
    table.increments("id").primary();
    table.integer("job_id").notNullable().references("id").inTable("jobs").onDelete("CASCADE");
    table.string("company_email", 255).notNullable();
    table.string("subject", 500).notNullable();
    table.text("html").notNullable();
    table.timestamp("send_after").notNullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
  });
};

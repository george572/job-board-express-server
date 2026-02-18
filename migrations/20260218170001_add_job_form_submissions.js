/**
 * Table for simple form submissions (alternative to CV upload).
 * Used when job.accept_form_submissions is true.
 */
exports.up = async function (knex) {
  await knex.schema.createTable("job_form_submissions", (table) => {
    table.increments("id").primary();
    table.integer("job_id").unsigned().notNullable().references("jobs.id").onDelete("CASCADE");
    table.string("user_id").nullable();       // user_uid if logged in
    table.integer("visitor_id").unsigned().nullable().references("visitors.id").onDelete("SET NULL");
    table.string("applicant_name").notNullable();
    table.string("applicant_email").notNullable();
    table.string("applicant_phone").nullable();
    table.text("message").nullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.index(["job_id"]);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("job_form_submissions");
};

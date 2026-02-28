exports.up = function (knex) {
  return knex.schema.createTable("hr_requested_resumes", (table) => {
    table.increments("id").primary();
    table.integer("hr_account_id").notNullable().references("id").inTable("hr_accounts").onDelete("CASCADE");
    table.string("job_name", 255).notNullable();
    table.string("candidate_id", 64).notNullable(); // user_uid or "no_cv_123"
    table.string("full_name", 255).notNullable();
    table.string("email", 255).nullable();
    table.text("cv_url").nullable();
    table.text("ai_summary").nullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.unique(["hr_account_id", "job_name", "candidate_id"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("hr_requested_resumes");
};

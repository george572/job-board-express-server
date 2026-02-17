exports.up = function (knex) {
  return knex.schema.createTable("cv_refusals", (table) => {
    table.increments("id").primary();
    table.string("user_id").notNullable();
    table.integer("job_id").unsigned().notNullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.unique(["user_id", "job_id"]);
    table.foreign("job_id").references("jobs.id").onDelete("CASCADE");
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("cv_refusals");
};

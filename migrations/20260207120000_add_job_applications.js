exports.up = function (knex) {
  return knex.schema.createTable("job_applications", (table) => {
    table.increments("id").primary();
    table.string("user_id").notNullable(); // user_uid who sent the CV
    table.integer("job_id").unsigned().notNullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.unique(["user_id", "job_id"]);
    table.foreign("job_id").references("jobs.id").onDelete("CASCADE");
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("job_applications");
};

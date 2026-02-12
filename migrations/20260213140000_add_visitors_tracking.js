exports.up = function (knex) {
  return knex.schema
    .createTable("visitors", (table) => {
      table.increments("id").primary();
      table.string("visitor_uid", 64).notNullable().unique();
      table.string("user_id", 128).nullable();
      table.integer("visit_count").unsigned().defaultTo(1).notNullable();
      table.timestamp("first_seen").defaultTo(knex.fn.now());
      table.timestamp("last_seen").defaultTo(knex.fn.now());
      table.index("visitor_uid");
      table.index("user_id");
    })
    .then(() =>
      knex.schema.createTable("visitor_job_clicks", (table) => {
        table.increments("id").primary();
        table.integer("visitor_id").unsigned().notNullable();
        table.integer("job_id").unsigned().notNullable();
        table.timestamp("clicked_at").defaultTo(knex.fn.now());
        table.foreign("visitor_id").references("visitors.id").onDelete("CASCADE");
        table.foreign("job_id").references("jobs.id").onDelete("CASCADE");
        table.index(["visitor_id", "job_id"]);
      })
    )
    .then(() =>
      knex.schema.alterTable("job_applications", (table) => {
        table.integer("visitor_id").unsigned().nullable();
        table.foreign("visitor_id").references("visitors.id").onDelete("SET NULL");
      })
    );
};

exports.down = function (knex) {
  return knex.schema
    .alterTable("job_applications", (table) => {
      table.dropForeign("visitor_id");
      table.dropColumn("visitor_id");
    })
    .then(() => knex.schema.dropTableIfExists("visitor_job_clicks"))
    .then(() => knex.schema.dropTableIfExists("visitors"));
};

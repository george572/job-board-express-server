exports.up = function (knex) {
  return knex.schema.createTable("hr_search_results", (table) => {
    table.string("session_id", 255).primary();
    table.jsonb("results").notNullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("hr_search_results");
};

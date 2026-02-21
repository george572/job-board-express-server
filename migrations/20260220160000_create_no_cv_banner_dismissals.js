exports.up = function (knex) {
  return knex.schema.createTable("no_cv_banner_dismissals", (table) => {
    table.increments("id").primary();
    table.string("visitor_id", 64).notNullable();
    table.timestamp("dismissed_at").defaultTo(knex.fn.now());
    table.index(["visitor_id", "dismissed_at"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("no_cv_banner_dismissals");
};

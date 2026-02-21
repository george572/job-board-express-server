exports.up = function (knex) {
  return knex.schema.createTable("user_without_cv", (table) => {
    table.increments("id").primary();
    table.string("name", 255).notNullable();
    table.string("email", 255).nullable();
    table.string("phone", 50).notNullable();
    table.text("short_description").nullable();
    table.text("categories").nullable(); // comma-separated list
    table.text("other_specify").nullable(); // when "სხვა" is selected
    table.timestamp("created_at").defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("user_without_cv");
};

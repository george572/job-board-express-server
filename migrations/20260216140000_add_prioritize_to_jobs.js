exports.up = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table.boolean("prioritize").defaultTo(false);
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table.dropColumn("prioritize");
  });
};

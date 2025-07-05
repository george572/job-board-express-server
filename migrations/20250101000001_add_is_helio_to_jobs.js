exports.up = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table.boolean("isHelio").defaultTo(false);
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table.dropColumn("isHelio");
  });
}; 
exports.up = function (knex) {
  return knex.schema.alterTable("jobs", (table) => {
    table.integer("view_count").defaultTo(0).notNullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("jobs", (table) => {
    table.dropColumn("view_count");
  });
};

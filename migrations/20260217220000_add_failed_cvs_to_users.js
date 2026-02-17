exports.up = function (knex) {
  return knex.schema.alterTable("users", (table) => {
    table.integer("failed_cvs").defaultTo(0);
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("users", (table) => {
    table.dropColumn("failed_cvs");
  });
};

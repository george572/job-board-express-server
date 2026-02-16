exports.up = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table.boolean("dont_send_email").defaultTo(false);
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table.dropColumn("dont_send_email");
  });
};

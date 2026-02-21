exports.up = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table.text("helio_url").nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table.dropColumn("helio_url");
  });
};

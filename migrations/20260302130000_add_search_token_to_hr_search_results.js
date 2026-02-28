exports.up = function (knex) {
  return knex.schema.alterTable("hr_search_results", (table) => {
    table.string("search_token", 64).unique().nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("hr_search_results", (table) => {
    table.dropColumn("search_token");
  });
};

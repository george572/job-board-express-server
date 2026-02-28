exports.up = function (knex) {
  return knex.schema.alterTable("hr_accounts", (table) => {
    table.string("company_name", 500).nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("hr_accounts", (table) => {
    table.dropColumn("company_name");
  });
};

exports.up = function (knex) {
  return knex.schema.createTable("hr_accounts", (table) => {
    table.increments("id").primary();
    table.string("company_identifier", 255).notNullable();
    table.string("email", 255).notNullable();
    table.string("password_hash", 512).notNullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.unique(["company_identifier", "email"]);
    table.index("company_identifier");
    table.index("email");
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("hr_accounts");
};

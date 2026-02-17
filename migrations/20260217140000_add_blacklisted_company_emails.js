/**
 * Blacklist table for company emails – vacancies from these will be rejected.
 */
exports.up = async function (knex) {
  await knex.schema.createTable("blacklisted_company_emails", (table) => {
    table.increments("id").primary();
    table.string("email", 255).unique().notNullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.text("note");
  });
  await knex("blacklisted_company_emails").insert({ email: "vacancy@ltb.ge" });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("blacklisted_company_emails");
};

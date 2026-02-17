/**
 * Add company_name to blacklisted_company_emails – block by company name and/or email.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("blacklisted_company_emails", (table) => {
    table.string("company_name", 500).nullable();
  });
  const hasLtb = await knex("blacklisted_company_emails").where("email", "vacancy@ltb.ge").first();
  if (hasLtb) {
    await knex("blacklisted_company_emails").where("email", "vacancy@ltb.ge").update({ company_name: "LTB" });
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable("blacklisted_company_emails", (table) => {
    table.dropColumn("company_name");
  });
};

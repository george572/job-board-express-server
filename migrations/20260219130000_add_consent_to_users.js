exports.up = function (knex) {
  return knex.schema.alterTable("users", (table) => {
    table.boolean("consent").notNullable().defaultTo(false);
    table.boolean("wants_cv_to_be_sent").notNullable().defaultTo(true);
    table.timestamp("consent_updated_at").nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("users", (table) => {
    table.dropColumn("consent_updated_at");
    table.dropColumn("wants_cv_to_be_sent");
    table.dropColumn("consent");
  });
};


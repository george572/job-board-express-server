exports.up = function (knex) {
  return knex.schema.alterTable("user_without_cv", (table) => {
    table.text("ai_description").nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("user_without_cv", (table) => {
    table.dropColumn("ai_description");
  });
};

exports.up = function (knex) {
  return knex.schema.alterTable("jobs", (table) => {
    table.dropColumn("jobDescriptionOriginal");
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("jobs", (table) => {
    table.text("jobDescriptionOriginal").nullable();
  });
};

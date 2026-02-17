exports.up = function (knex) {
  return knex.schema.alterTable("cv_refusals", (table) => {
    table.boolean("complaint_sent").defaultTo(false);
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("cv_refusals", (table) => {
    table.dropColumn("complaint_sent");
  });
};

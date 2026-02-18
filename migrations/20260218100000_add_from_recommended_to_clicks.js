exports.up = function (knex) {
  return knex.schema.alterTable("visitor_job_clicks", (table) => {
    table.boolean("from_recommended").defaultTo(false);
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("visitor_job_clicks", (table) => {
    table.dropColumn("from_recommended");
  });
};

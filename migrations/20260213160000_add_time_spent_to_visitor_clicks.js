exports.up = function (knex) {
  return knex.schema.alterTable("visitor_job_clicks", (table) => {
    table.integer("time_spent_seconds").unsigned().nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("visitor_job_clicks", (table) => {
    table.dropColumn("time_spent_seconds");
  });
};

exports.up = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table
      .enum("job_status", ["pending", "approved", "hidden"])
      .defaultTo("pending");
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table.dropColumn("job_status");
  });
};

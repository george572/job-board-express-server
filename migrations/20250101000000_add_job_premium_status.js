exports.up = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table
      .enum("job_premium_status", ["regular", "premium", "premiumPlus"])
      .defaultTo("regular");
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("jobs", function (table) {
    table.dropColumn("job_premium_status");
  });
}; 
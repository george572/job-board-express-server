exports.up = function (knex) {
  return knex.schema.alterTable("hr_requested_resumes", (table) => {
    table.string("match_verdict", 32).nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("hr_requested_resumes", (table) => {
    table.dropColumn("match_verdict");
  });
};

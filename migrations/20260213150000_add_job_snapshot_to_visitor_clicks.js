exports.up = function (knex) {
  return knex.schema.alterTable("visitor_job_clicks", (table) => {
    table.string("job_salary", 128).nullable();
    table.string("job_title", 512).nullable();
    table.integer("category_id").unsigned().nullable();
    table.string("job_category_name", 128).nullable();
    table.string("job_city", 128).nullable();
    table.string("job_experience", 64).nullable();
    table.string("job_type", 32).nullable(); // full-time, part-time
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("visitor_job_clicks", (table) => {
    table.dropColumn("job_salary");
    table.dropColumn("job_title");
    table.dropColumn("category_id");
    table.dropColumn("job_category_name");
    table.dropColumn("job_city");
    table.dropColumn("job_experience");
    table.dropColumn("job_type");
  });
};

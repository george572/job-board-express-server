
exports.up = function (knex) {
    return knex.schema.alterTable("company_logos", (table) => {
      table
        .integer("job_id")
        .unsigned()
        .references("id")
        .inTable("jobs")
        .onDelete("CASCADE"); // Delete logo when job is deleted
    });
  };
  
  exports.down = function (knex) {
    return knex.schema.alterTable("company_logos", (table) => {
      table.dropForeign("job_id");
    });
  };
  
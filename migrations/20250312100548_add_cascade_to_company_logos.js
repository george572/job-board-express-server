exports.up = function (knex) {
    return knex.schema.alterTable("company_logos", (table) => {
      table.dropForeign("job_id"); // Remove existing foreign key (if any)
      table
        .integer("job_id")
        .unsigned()
        .notNullable()
        .references("id")
        .inTable("jobs")
        .onDelete("CASCADE"); // Ensure cascade deletion
    });
  };
  
  exports.down = function (knex) {
    return knex.schema.alterTable("company_logos", (table) => {
      table.dropForeign("job_id");
    });
  };
  
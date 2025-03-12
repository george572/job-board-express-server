exports.up = async function (knex) {
    await knex.schema.alterTable("company_logos", (table) => {
      table.dropForeign("job_id"); // Remove existing foreign key
    });
  
    // Set a default value for NULL job_id before making it NOT NULL
    await knex("company_logos")
      .whereNull("job_id")
      .update({ job_id: knex.raw("(SELECT id FROM jobs LIMIT 1)") });
  
    return knex.schema.alterTable("company_logos", (table) => {
      table.integer("job_id").unsigned().notNullable().alter();
      table.foreign("job_id").references("id").inTable("jobs").onDelete("CASCADE");
    });
  };
  
  exports.down = async function (knex) {
    return knex.schema.alterTable("company_logos", (table) => {
      table.dropForeign("job_id");
      table.integer("job_id").nullable().alter();
    });
  };
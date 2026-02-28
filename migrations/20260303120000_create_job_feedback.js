/**
 * Table for anonymous job feedback (pills: likes, dislikes, other).
 * HR sees aggregated feedback only, no user/visitor identifiers.
 */
exports.up = async function (knex) {
  await knex.schema.createTable("job_feedback", (table) => {
    table.increments("id").primary();
    table.integer("job_id").unsigned().notNullable().references("jobs.id").onDelete("CASCADE");
    table.jsonb("pills").notNullable(); // e.g. ["competitive_salary", "vague_description"]
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.index(["job_id"]);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("job_feedback");
};

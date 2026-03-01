/**
 * Add candidates_must_be_exact_match to jobs.
 * When true, Gemini assesses CV fit before allowing application.
 * Only STRONG_MATCH and GOOD_MATCH pass; PARTIAL_MATCH and WEAK_MATCH are rejected.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("jobs", (table) => {
    table.boolean("candidates_must_be_exact_match").defaultTo(false).notNullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("jobs", (table) => {
    table.dropColumn("candidates_must_be_exact_match");
  });
};

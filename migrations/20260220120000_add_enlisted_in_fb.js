/**
 * Temporary table for FB promo enlist tracking.
 * One row per unique click; count = number of people who clicked.
 */
exports.up = async function (knex) {
  await knex.schema.createTable("enlisted_in_fb", (table) => {
    table.increments("id").primary();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("enlisted_in_fb");
};

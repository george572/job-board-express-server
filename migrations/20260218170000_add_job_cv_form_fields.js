/**
 * Add job fields:
 * - disable_cv_filter: when true, skip AI fit check and send all CVs
 * - accept_form_submissions: when true, job accepts simple form instead of resume
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("jobs", (table) => {
    table.boolean("disable_cv_filter").defaultTo(false).notNullable();
    table.boolean("accept_form_submissions").defaultTo(false).notNullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("jobs", (table) => {
    table.dropColumn("disable_cv_filter");
    table.dropColumn("accept_form_submissions");
  });
};

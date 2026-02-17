/**
 * Track which emails have been sent per job.
 * - general_marketing_email_sent: "your vacancy is on our site" email
 * - cv_submissions_email_sent: "your job has X applicants" email (on 3rd CV)
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("jobs", (table) => {
    table.boolean("general_marketing_email_sent").defaultTo(false);
    table.boolean("cv_submissions_email_sent").defaultTo(false);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("jobs", (table) => {
    table.dropColumn("general_marketing_email_sent");
    table.dropColumn("cv_submissions_email_sent");
  });
};

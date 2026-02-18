/**
 * Change send_after to timestamptz so all scheduling uses UTC explicitly.
 * Existing values are interpreted as UTC when converting.
 */
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE new_job_email_queue
    ALTER COLUMN send_after TYPE timestamptz USING send_after AT TIME ZONE 'UTC'
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE new_job_email_queue
    ALTER COLUMN send_after TYPE timestamp WITHOUT TIME ZONE
  `);
};

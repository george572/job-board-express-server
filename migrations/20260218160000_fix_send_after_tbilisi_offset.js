/**
 * Fix send_after values that were wrongly interpreted as UTC during the
 * timestamp->timestamptz migration. They were stored as Tbilisi local time
 * (10:20 Georgia) but we interpreted as UTC (so became 14:20 Georgia display).
 * Subtract 4 hours to correct: 10:20 UTC -> 06:20 UTC = 10:20 Tbilisi.
 */
exports.up = async function (knex) {
  await knex.raw(`
    UPDATE new_job_email_queue
    SET send_after = send_after - interval '4 hours'
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    UPDATE new_job_email_queue
    SET send_after = send_after + interval '4 hours'
  `);
};

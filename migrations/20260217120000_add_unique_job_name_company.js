/**
 * Add unique constraint on (jobName, companyName) for approved jobs.
 * Prevents duplicate inserts when same form is submitted from multiple tabs.
 * Deletes existing duplicates first (keeps row with lowest id).
 */
exports.up = async function (knex) {
  await knex.raw(`
    DELETE FROM jobs
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY TRIM("jobName"), TRIM("companyName")
            ORDER BY id
          ) AS rn
        FROM jobs
        WHERE job_status = 'approved'
      ) sub
      WHERE rn > 1
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX jobs_approved_name_company_unique
    ON jobs (TRIM("jobName"), TRIM("companyName"))
    WHERE job_status = 'approved'
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS jobs_approved_name_company_unique');
};

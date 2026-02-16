/**
 * Add expires_at to jobs for archive/expiry.
 * - Jobs with expires_at in the past are hidden from listings but viewable at /vakansia/:slug
 * - New jobs get expires_at = created_at + 30 days via trigger
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("jobs", (table) => {
    table.timestamp("expires_at").nullable();
  });

  // Backfill: set expires_at = created_at + 30 days for existing jobs
  await knex.raw(`
    UPDATE jobs
    SET expires_at = created_at + INTERVAL '30 days'
    WHERE expires_at IS NULL
  `);

  // Trigger: auto-set expires_at for new inserts
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_job_expires_at()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.expires_at IS NULL AND NEW.created_at IS NOT NULL THEN
        NEW.expires_at := NEW.created_at + INTERVAL '30 days';
      ELSIF NEW.expires_at IS NULL THEN
        NEW.expires_at := NOW() + INTERVAL '30 days';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.raw(`
    DROP TRIGGER IF EXISTS trigger_set_job_expires_at ON jobs;
    CREATE TRIGGER trigger_set_job_expires_at
    BEFORE INSERT ON jobs
    FOR EACH ROW
    EXECUTE PROCEDURE set_job_expires_at()
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trigger_set_job_expires_at ON jobs`);
  await knex.raw(`DROP FUNCTION IF EXISTS set_job_expires_at()`);
  await knex.schema.alterTable("jobs", (table) => {
    table.dropColumn("expires_at");
  });
};

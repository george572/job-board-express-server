/**
 * Performance optimizations for jobs:
 * - Add jobSalary_min computed column with trigger
 * - Enable pg_trgm and add trigram indexes for search
 * - Add indexes for common filters and ordering
 */

exports.up = async function (knex) {
  // Enable pg_trgm extension (no-op if already enabled)
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  // Add computed minimum salary column if it doesn't exist yet
  const hasSalaryMin = await knex.schema.hasColumn('jobs', 'jobSalary_min');
  if (!hasSalaryMin) {
    await knex.schema.alterTable('jobs', (table) => {
      table.integer('jobSalary_min').nullable();
    });
  }

  // Function to extract first numeric part from jobSalary text
  await knex.raw(`
    CREATE OR REPLACE FUNCTION extract_min_salary(salary_text TEXT)
    RETURNS INTEGER AS $$
    BEGIN
      RETURN CAST(
        NULLIF(
          REGEXP_REPLACE(COALESCE(salary_text, ''), '[^0-9].*', ''),
          ''
        ) AS INTEGER
      );
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `);

  // Backfill existing rows (quote camelCase columns)
  await knex.raw(`
    UPDATE jobs
    SET "jobSalary_min" = extract_min_salary("jobSalary")
    WHERE "jobSalary" IS NOT NULL AND "jobSalary_min" IS NULL;
  `);

  // Trigger to maintain jobSalary_min on insert/update
  await knex.raw(`
    CREATE OR REPLACE FUNCTION update_salary_min()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW."jobSalary_min" := extract_min_salary(NEW."jobSalary");
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'jobs_salary_min_trigger'
      ) THEN
        CREATE TRIGGER jobs_salary_min_trigger
        BEFORE INSERT OR UPDATE ON jobs
        FOR EACH ROW
        EXECUTE FUNCTION update_salary_min();
      END IF;
    END$$;
  `);

  // Basic filter/order indexes
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (job_status)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs ("companyName")');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_jobs_category ON jobs (category_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_jobs_experience ON jobs (job_experience)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs (job_type)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_jobs_premium ON jobs (job_premium_status)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC)');

  // Salary min index (used for sorting/filtering)
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_jobs_salary_min ON jobs ("jobSalary_min") WHERE "jobSalary_min" IS NOT NULL'
  );

  // Trigram indexes for fast ILIKE search on jobName and companyName
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_jobs_jobname_trgm ON jobs USING gin ("jobName" gin_trgm_ops)'
  );
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_jobs_companyname_trgm ON jobs USING gin ("companyName" gin_trgm_ops)'
  );

  // Composite index for common filters
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_jobs_filters_composite ON jobs (job_status, job_premium_status, created_at DESC)'
  );
};

exports.down = async function (knex) {
  // Drop indexes (if they exist)
  await knex.raw('DROP INDEX IF EXISTS idx_jobs_filters_composite');
  await knex.raw('DROP INDEX IF EXISTS idx_jobs_companyname_trgm');
  await knex.raw('DROP INDEX IF EXISTS idx_jobs_jobname_trgm');
  await knex.raw('DROP INDEX IF EXISTS idx_jobs_salary_min');
  await knex.raw('DROP INDEX IF EXISTS idx_jobs_created_at');
  await knex.raw('DROP INDEX IF EXISTS idx_jobs_premium');
  await knex.raw('DROP INDEX IF EXISTS idx_jobs_type');
  await knex.raw('DROP INDEX IF EXISTS idx_jobs_experience');
  await knex.raw('DROP INDEX IF EXISTS idx_jobs_category');
  await knex.raw('DROP INDEX IF EXISTS idx_jobs_company');
  await knex.raw('DROP INDEX IF EXISTS idx_jobs_status');

  // Drop trigger and function
  await knex.raw('DROP TRIGGER IF EXISTS jobs_salary_min_trigger ON jobs');
  await knex.raw('DROP FUNCTION IF EXISTS update_salary_min()');
  await knex.raw('DROP FUNCTION IF EXISTS extract_min_salary(TEXT)');

  // Drop computed column if it exists
  const hasSalaryMin = await knex.schema.hasColumn('jobs', 'jobSalary_min');
  if (hasSalaryMin) {
    await knex.schema.alterTable('jobs', (table) => {
      table.dropColumn('jobSalary_min');
    });
  }
};


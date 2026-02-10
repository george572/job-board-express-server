/**
 * Fix jobSalary_min trigger to use correctly quoted camelCase columns.
 * This is safe/idempotent and only redefines the function + ensures trigger exists.
 */

exports.up = async function (knex) {
  // Correct the trigger function
  await knex.raw(`
    CREATE OR REPLACE FUNCTION update_salary_min()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW."jobSalary_min" := extract_min_salary(NEW."jobSalary");
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Ensure the trigger exists and uses this function
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
};

exports.down = async function () {
  // No-op: we keep the fixed function/trigger even if this migration is rolled back.
  return;
};


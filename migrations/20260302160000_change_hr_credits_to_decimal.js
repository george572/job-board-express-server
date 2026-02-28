exports.up = async function (knex) {
  // PostgreSQL: change hr_accounts.credits from integer to decimal(10,2)
  await knex.raw(
    'ALTER TABLE hr_accounts ALTER COLUMN credits TYPE decimal(10,2) USING COALESCE(credits, 100)::decimal(10,2);'
  );
  await knex.raw(
    'ALTER TABLE hr_accounts ALTER COLUMN credits SET DEFAULT 100;'
  );
  await knex.raw(
    'ALTER TABLE hr_accounts ALTER COLUMN credits SET NOT NULL;'
  );

  // hr_credits_history: delta and balance_after to decimal(10,2)
  await knex.raw(
    'ALTER TABLE hr_credits_history ALTER COLUMN delta TYPE decimal(10,2) USING delta::decimal(10,2);'
  );
  await knex.raw(
    'ALTER TABLE hr_credits_history ALTER COLUMN balance_after TYPE decimal(10,2) USING balance_after::decimal(10,2);'
  );
};

exports.down = async function (knex) {
  await knex.raw(
    'ALTER TABLE hr_credits_history ALTER COLUMN balance_after TYPE integer USING ROUND(balance_after)::integer;'
  );
  await knex.raw(
    'ALTER TABLE hr_credits_history ALTER COLUMN delta TYPE integer USING ROUND(delta)::integer;'
  );
  await knex.raw(
    'ALTER TABLE hr_accounts ALTER COLUMN credits TYPE integer USING ROUND(credits)::integer;'
  );
  await knex.raw(
    'ALTER TABLE hr_accounts ALTER COLUMN credits SET DEFAULT 100;'
  );
};


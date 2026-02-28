exports.up = async function (knex) {
  await knex.schema.alterTable("hr_accounts", (table) => {
    table.integer("credits").notNullable().defaultTo(100);
  });

  await knex.schema.createTable("hr_credits_history", (table) => {
    table.increments("id").primary();
    table.integer("hr_account_id").notNullable().references("id").inTable("hr_accounts").onDelete("CASCADE");
    table.integer("delta").notNullable(); // + gained, - spent
    table.integer("balance_after").notNullable();
    table.string("kind", 32).notNullable(); // initial_grant | unlock_candidate | manual_adjustment
    table.string("job_name", 255).nullable();
    table.string("candidate_id", 64).nullable(); // user_uid or "no_cv_123"
    table.string("match_verdict", 32).nullable(); // STRONG_MATCH | GOOD_MATCH
    table.timestamp("created_at").defaultTo(knex.fn.now());

    table.index(["hr_account_id", "created_at"]);
  });

  // Backfill history for existing accounts (one-time initial grant)
  const rows = await knex("hr_accounts").select("id", "credits");
  if (rows && rows.length) {
    const now = knex.fn.now();
    const inserts = rows.map((r) => ({
      hr_account_id: r.id,
      delta: 100,
      balance_after: typeof r.credits === "number" ? r.credits : 100,
      kind: "initial_grant",
      created_at: now,
    }));
    // Chunk inserts to avoid large queries
    const chunkSize = 500;
    for (let i = 0; i < inserts.length; i += chunkSize) {
      await knex("hr_credits_history").insert(inserts.slice(i, i + chunkSize));
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists("hr_credits_history");
  await knex.schema.alterTable("hr_accounts", (table) => {
    table.dropColumn("credits");
  });
};


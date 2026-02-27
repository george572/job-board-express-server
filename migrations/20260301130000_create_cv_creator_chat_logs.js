exports.up = function (knex) {
  return knex.schema.createTable("cv_creator_chat_logs", (table) => {
    table.bigIncrements("id").primary();
    table.string("session_id").index();
    table.string("user_id").nullable().index();
    table.integer("turn_index").notNullable();
    table.boolean("had_existing_cv").notNullable().defaultTo(false);
    table.text("user_message").nullable();
    table.text("assistant_reply").notNullable();
    table.jsonb("cv_data").nullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("cv_creator_chat_logs");
};


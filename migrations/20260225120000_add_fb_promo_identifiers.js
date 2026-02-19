/**
 * Add visitor_id, user_id, action to enlisted_in_fb so we can
 * identify who interacted and avoid showing the promo again.
 * action: 'enlist' | 'dismiss' (null = legacy row, treated as enlist)
 */
exports.up = async function (knex) {
  await knex.schema.alterTable("enlisted_in_fb", (table) => {
    table.integer("visitor_id").unsigned().nullable();
    table.string("user_id", 128).nullable();
    table.string("action", 16).nullable(); // 'enlist' | 'dismiss'
    table.index("visitor_id");
    table.index("user_id");
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("enlisted_in_fb", (table) => {
    table.dropColumn("visitor_id");
    table.dropColumn("user_id");
    table.dropColumn("action");
  });
};

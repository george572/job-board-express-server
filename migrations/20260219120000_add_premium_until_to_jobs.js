/**
 * Add premium_until date to jobs. When set, premium/premiumPlus status
 * is automatically cleared once today passes this date.
 */
exports.up = function (knex) {
  return knex.schema.alterTable("jobs", (table) => {
    table.date("premium_until").nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("jobs", (table) => {
    table.dropColumn("premium_until");
  });
};

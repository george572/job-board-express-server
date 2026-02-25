exports.up = function (knex) {
  return knex.schema.alterTable("jobs", (table) => {
    table.string("work_mode").defaultTo("ადგილზე");
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("jobs", (table) => {
    table.dropColumn("work_mode");
  });
};

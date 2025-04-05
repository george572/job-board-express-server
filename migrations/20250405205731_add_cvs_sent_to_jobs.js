exports.up = function (knex) {
    return knex.schema.alterTable("jobs", function (table) {
      table.integer("cvs_sent").defaultTo(0);
    });
  };
  
  exports.down = function (knex) {
    return knex.schema.alterTable("jobs", function (table) {
      table.dropColumn("cvs_sent");
    });
  };
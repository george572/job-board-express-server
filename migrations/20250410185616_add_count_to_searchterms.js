exports.up = function(knex) {
    return knex.schema.table('searchterms', function(table) {
      table.integer('count').defaultTo(0);  // Adds the count column with a default value of 0
    });
  };
  
  exports.down = function(knex) {
    return knex.schema.table('searchterms', function(table) {
      table.dropColumn('count');  // Drops the count column if rolling back
    });
  };
exports.up = function(knex) {
    return knex.schema.createTable('searchterms', function(table) {
      table.increments('id').primary();
      table.string('searchTerm').notNullable();
      table.timestamps(true, true);
    });
  };
  
  exports.down = function(knex) {
    return knex.schema.dropTable('searchterms');
  };
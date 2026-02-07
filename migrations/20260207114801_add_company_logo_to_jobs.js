// migrations/2024xxxx_add_company_logo_to_jobs.js

exports.up = function(knex) {
    return knex.schema.table('jobs', function(table) {
      // We use 'text' to accommodate very long URLs
      table.text('company_logo').nullable(); 
    });
  };
  
  exports.down = function(knex) {
    return knex.schema.table('jobs', function(table) {
      table.dropColumn('company_logo');
    });
  };
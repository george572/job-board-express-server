exports.up = function(knex) {
  return knex.schema.table('resumes', (table) => {
    table.string('file_name');
  });
};

exports.down = function(knex) {
  return knex.schema.table('resumes', (table) => {
    table.dropColumn('file_name');
  });
};
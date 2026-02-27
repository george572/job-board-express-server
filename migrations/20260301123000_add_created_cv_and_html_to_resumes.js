exports.up = function(knex) {
  return knex.schema.table('resumes', (table) => {
    table.boolean('created_cv_on_samushao_ge').notNullable().defaultTo(false);
    table.text('cv_html');
  });
};

exports.down = function(knex) {
  return knex.schema.table('resumes', (table) => {
    table.dropColumn('created_cv_on_samushao_ge');
    table.dropColumn('cv_html');
  });
};


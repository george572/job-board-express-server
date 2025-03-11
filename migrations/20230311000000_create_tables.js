exports.up = function (knex) {
    return knex.schema
      .createTable('categories', (table) => {
        table.increments('id').primary();
        table.string('name').unique().notNullable();
      })
      .createTable('jobs', (table) => {
        table.increments('id').primary();
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.timestamp('updated_at').defaultTo(knex.fn.now());
        table.string('companyName').notNullable();
        table.string('user_uid').notNullable();
        table.string('company_email').notNullable();
        table.string('jobName').notNullable();
        table.string('jobSalary');
        table.text('jobDescription').notNullable();
        table.string('job_experience');
        table.string('job_city');
        table.string('job_address');
        table.string('job_type');
        table.boolean('jobIsUrgent');
        table.integer('category_id').unsigned().notNullable();
        table.foreign('category_id').references('categories.id').onDelete('RESTRICT');
      })
      .createTable('users', (table) => {
        table.increments('id').primary();
        table.string('user_uid').notNullable();
        table.string('user_name').notNullable();
        table.string('user_email').notNullable();
        table.string('user_type').defaultTo('user');
        table.timestamp('updated_at').defaultTo(knex.fn.now());
        table.timestamp('created_at').defaultTo(knex.fn.now());
      })
      .createTable('resumes', (table) => {
        table.increments('id').primary();
        table.string('user_id');
        table.string('file_url').notNullable();
        table.timestamp('updated_at').defaultTo(knex.fn.now());
        table.timestamp('created_at').defaultTo(knex.fn.now());
      })
      .createTable('company_logos', (table) => {
        table.increments('id').primary();
        table.string('secure_url');
        table.string('user_uid');
      });
  };
  
  exports.down = function (knex) {
    return knex.schema
      .dropTableIfExists('company_logos')
      .dropTableIfExists('resumes')
      .dropTableIfExists('users')
      .dropTableIfExists('jobs')
      .dropTableIfExists('categories');
  };
  
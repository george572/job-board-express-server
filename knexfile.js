require('dotenv').config();

module.exports = {
  development: {
    client: 'pg',
    connection: {
      host: '127.0.0.1',
      user: 'postgres',
      password: '1234',
      database: 'samushao',
    },
  },
  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 2, max: 10 },
    ssl: {
      rejectUnauthorized: false
    },
    migrations: { tableName: 'knex_migrations' },
  },
};

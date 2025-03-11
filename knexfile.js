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
    connection: process.env.DATABASE_URL + "?sslmode=disable",
    ssl: {
      rejectUnauthorized: true,
    },
    pool: { min: 2, max: 10 },
    migrations: { tableName: 'knex_migrations' },
  },
};

require("dotenv").config();

const knexConfig = {
  development: {
    client: "pg",
    connection: {
      host: "127.0.0.1",
      user: "postgres",
      password: "1234",
      database: "samushao",
    },
  },
  production: {
    client: "pg",
    connection: process.env.DATABASE_URL, // Use Heroku's DATABASE_URL
    migrations: { tableName: "knex_migrations" },
    ssl: {
      rejectUnauthorized: false,
    },
  },
};

module.exports = knexConfig[process.env.NODE_ENV || 'development']; // Ensure correct environment-based config

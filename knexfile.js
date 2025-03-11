require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Try to read certificate file if it exists
let ca;
try {
  ca = fs.readFileSync(path.join(__dirname, 'global-bundle.pem')).toString();
} catch (e) {
  ca = undefined;
}
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
    connection: process.env.DATABASE_URL + "?sslmode=require",
    pool: { min: 2, max: 10 },
    migrations: { tableName: 'knex_migrations' },
  },
};

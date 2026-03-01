// Use same DB as main app: set DATABASE_URL in .env, or copy connection from main app knexfile.
const connection = process.env.DATABASE_URL
  ? process.env.DATABASE_URL
  : {
      host: process.env.PGHOST || "localhost",
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
    };

const shared = {
  client: "pg",
  connection,
  pool: { min: 2, max: 10 },
  debug: false,
};

module.exports = {
  development: shared,
  production: shared,
  local: shared,
};

const shared = {
  client: "pg",
  connection: {
    host: "ep-frosty-mode-aglu6csx-pooler.c-2.eu-central-1.aws.neon.tech",
    user: "neondb_owner",
    password: "npg_dtCoyp2jBh7H",
    database: "neondb",
    ssl: { rejectUnauthorized: false }
  },
  pool: {
    min: 2,
    max: 10,
    idleTimeoutMillis: 60000,
    reapIntervalMillis: 10000,
  },
  debug: false
};

module.exports = {
  development: shared,
  production: shared,
};

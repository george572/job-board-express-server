require("dotenv").config();

module.exports = {
  development: {
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
      acquireTimeoutMillis: 30000,
      idleTimeoutMillis: 10000,
      createTimeoutMillis: 30000,
      reapIntervalMillis: 1000,
      afterCreate: (conn, done) => {
        console.log("[knex] New DB connection created");
        done(null, conn);
      },
    },
  },
  production: {
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
      acquireTimeoutMillis: 30000,
      idleTimeoutMillis: 10000,
      createTimeoutMillis: 30000,
      reapIntervalMillis: 1000,
      afterCreate: (conn, done) => {
        console.log("[knex] New DB connection created");
        done(null, conn);
      },
    },
  },
};

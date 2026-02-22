module.exports = {
  production: {
    client: "pg",
    connection: {
      host: "ep-frosty-mode-aglu6csx.c-2.eu-central-1.aws.neon.tech",  // Direct host, NO pooler
      user: "neondb_owner",
      password: "npg_dtCoyp2jBh7H",
      database: "neondb",
      ssl: { rejectUnauthorized: false }
    },
    pool: {  // Keep Knex pool for direct connections
      min: 0,    // Let it scale to zero
      max: 8,    // Conservative for Fly
      idleTimeoutMillis: 30000,
      reapIntervalMillis: 5000
      // NO afterCreate - kills performance
    },
    // Add query logging only if debugging
    debug: false
  }
};

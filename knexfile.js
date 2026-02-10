require("dotenv").config();

module.exports = {
  development: {
    client: "pg",
    connection: {
      host: "ep-frosty-mode-aglu6csx-pooler.c-2.eu-central-1.aws.neon.tech",
      user: "neondb_owner",
      password: "npg_dtCoyp2jBh7H",
      database: "neondb",
      ssl: { rejectUnauthorized: false }  // Now properly included
    }
  },
  production: {
    client: "pg",
    connection: {
      host: "ep-frosty-mode-aglu6csx-pooler.c-2.eu-central-1.aws.neon.tech",
      user: "neondb_owner",
      password: "npg_dtCoyp2jBh7H",
      database: "neondb",
      ssl: { rejectUnauthorized: false }  // Now properly included
    }
  }
};

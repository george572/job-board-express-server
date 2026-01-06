require("dotenv").config();

module.exports = {
  development: {
    client: "pg",
    connection: {
      host: "ceual2t8lkvosl.cluster-czz5s0kz4scl.eu-west-1.rds.amazonaws.com",
      user: "u2bfqm7k36k4lv",
      password: "p9f11fba4229eddb38a1d139cf31a68de6f7052bde4577d14a7e3f2f8401305b3",
      database: "d5s0bjrrt5qckm",
      ssl: { rejectUnauthorized: false }  // Now properly included
    }
  },
  production: {
    client: "pg",
    connection: process.env.DATABASE_URL ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    } : {
      host: "ceual2t8lkvosl.cluster-czz5s0kz4scl.eu-west-1.rds.amazonaws.com",
      user: "u2bfqm7k36k4lv",
      password: "p9f11fba4229eddb38a1d139cf31a68de6f7052bde4577d14a7e3f2f8401305b3",
      database: "d5s0bjrrt5qckm",
      ssl: { rejectUnauthorized: false }
    }
  }
};

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
      connection: "postgres://ubcc3d5l45k0qm:pc43eb9f4c1646292456193909598034d31ebd7170373e4d52522d695d29443aa@ccaml3dimis7eh.cluster-czz5s0kz4scl.eu-west-1.rds.amazonaws.com:5432/d6vma50v9o1pmr",
      pool: { min: 2, max: 10 },
      ssl: {
        rejectUnauthorized: false
      },
      migrations: { tableName: 'knex_migrations' },
    },
  };